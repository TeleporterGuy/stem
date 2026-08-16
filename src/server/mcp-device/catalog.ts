import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { log } from '../log';
import { piMcpDeviceCatalogPath } from '../workspace/paths';
import type {
  DeviceMcpAnnouncement,
  DeviceMcpCatalog,
  DeviceMcpServerReport,
  DeviceMcpTool
} from '../../shared/types';

// What each device says it is hosting, remembered across the moment it goes away.
//
// This file is the whole of decision ③: availability is "has an open stream",
// evaluated per turn, with no handshake — which only works if what the device
// CAN do is known independently of whether it is up right now. So the catalog is
// stored here, on the server, and a sleeping Mac's tools stay in the assistant's
// context marked unavailable instead of quietly disappearing from what it knows
// it can do.
//
// Nothing here is trusted. A device writes its own entry, and what it writes is
// rendered into a model's prompt on later turns, so every string that arrives is
// bounded and every list is capped before it reaches the disk — see normalize().

/** How the catalog is read and written; injected so the router can be tested. */
export interface DeviceMcpCatalogStore {
  read(): Promise<DeviceMcpCatalog>;
  write(next: DeviceMcpCatalog): Promise<void>;
}

/** An empty catalog — a missing or unreadable file, and the shape of a fresh one. */
export function emptyCatalog(): DeviceMcpCatalog {
  return { version: 1, devices: {} };
}

/**
 * Caps on what one device may announce.
 *
 * These are not defences against a hostile client — a paired device is already
 * trusted with far more than this — they are what keeps one misconfigured MCP
 * server from eating the context window of every turn from now on. A server
 * exposing four hundred tools is a real thing that exists, and the failure it
 * causes (a prompt so large the model has no room to answer) is one nobody
 * connects back to a checkbox they ticked last week.
 */
const MAX_SERVERS = 64;
const MAX_TOOLS = 200;
const MAX_NAME = 200;
const MAX_TEXT = 2_000;

function clip(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function normalizeTool(raw: unknown): DeviceMcpTool | null {
  if (!raw || typeof raw !== 'object') return null;
  const tool = raw as Partial<DeviceMcpTool>;
  const name = clip(tool.name, MAX_NAME);
  if (!name) return null;
  const description = clip(tool.description, MAX_TEXT);
  const signature = clip(tool.signature, MAX_TEXT);
  return {
    name,
    ...(description ? { description } : {}),
    ...(signature ? { signature } : {})
  };
}

function normalizeServer(raw: unknown): DeviceMcpServerReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const server = raw as Partial<DeviceMcpServerReport>;
  const name = clip(server.name, MAX_NAME);
  if (!name) return null;
  // An unrecognized status reads as `failed` rather than being dropped: a server
  // whose state we cannot name is one the assistant must not be told is ready.
  const status =
    server.status === 'ready' || server.status === 'unapproved' ? server.status : 'failed';
  const tools = Array.isArray(server.tools)
    ? server.tools.slice(0, MAX_TOOLS).map(normalizeTool).filter((t): t is DeviceMcpTool => !!t)
    : [];
  const error = clip(server.error, MAX_TEXT);
  const fingerprint = clip(server.fingerprint, MAX_NAME);
  return {
    name,
    status,
    ...(error ? { error } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(tools.length > 0 ? { tools } : {})
  };
}

/**
 * One announcement, reduced to what may be stored. Whatever arrived that this
 * does not recognize is dropped rather than kept "just in case": the file is
 * read back into a prompt, and a field nobody renders is a field nobody is
 * checking the size of.
 */
export function normalizeAnnouncement(raw: unknown): DeviceMcpAnnouncement {
  const servers = (raw as Partial<DeviceMcpAnnouncement> | null)?.servers;
  if (!Array.isArray(servers)) return { servers: [] };
  return {
    servers: servers
      .slice(0, MAX_SERVERS)
      .map(normalizeServer)
      .filter((s): s is DeviceMcpServerReport => !!s)
  };
}

/** The catalog as it is on disk, or an empty one when it is missing or corrupt. */
async function readCatalogFile(): Promise<DeviceMcpCatalog> {
  let raw: string;
  try {
    raw = await readFile(piMcpDeviceCatalogPath(), 'utf8');
  } catch {
    return emptyCatalog(); // never written yet
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceMcpCatalog>;
    if (!parsed?.devices || typeof parsed.devices !== 'object') return emptyCatalog();
    return { version: 1, devices: parsed.devices };
  } catch {
    // Unlike mcp.json, losing this costs nothing anybody typed: every device
    // re-announces when it next connects, and until then the honest answer is
    // that we do not know what it hosts. So no `.corrupt` sibling and no throw.
    log('mcp-device', 'the device catalog is unreadable; starting from empty');
    return emptyCatalog();
  }
}

async function writeCatalogFile(next: DeviceMcpCatalog): Promise<void> {
  const path = piMcpDeviceCatalogPath();
  await mkdir(dirname(path), { recursive: true });
  // Temp-then-rename, like every other file under the pi home: a force-quit
  // mid-write can leave a stray `.tmp` but never a half-written catalog that
  // reads back as corrupt on the next boot.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * The real store. Reads and writes are serialized through one tail: announcements
 * from two devices can land in the same tick, and read-modify-write on a whole
 * file is exactly the shape that loses one of them.
 */
export function fileCatalogStore(): DeviceMcpCatalogStore {
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    read: () => queue(readCatalogFile),
    write: (next) => queue(() => writeCatalogFile(next))
  };
}
