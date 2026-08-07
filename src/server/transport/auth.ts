import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { devicesStorePath } from '../workspace/paths';

// Who is allowed to talk to the transport. Two independent gates, because the
// transport is the first Stem surface reachable from off the machine:
//
//   1. A bearer token — 32 random bytes as hex, held in the device registry
//      (devices.json, 0600) and compared in constant time. The desktop's own
//      record is minted by the server at first boot and read straight off the
//      state root — same machine, same trust boundary, so there is no pairing
//      step. Pairing a device that does NOT share this disk is Phase 2's
//      one-shot-code flow, and it is what turns this into a real list.
//   2. A request-origin check — the DNS-rebinding defense. No browser speaks to
//      this transport any more (the phone's web client was removed with the
//      phone role), so rebinding has no obvious vehicle today — but the check
//      costs one header comparison and would be the difference if anything
//      browser-shaped is ever pointed at Stem again. Checking the *Host* header
//      against the hostnames Stem can legitimately be reached under is what
//      actually stops rebinding: a matching Origin/Host pair proves nothing,
//      since a rebound attacker controls both.

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * What a device is trusted to be. One value, and the field is kept anyway: the
 * registry has always carried it, dropping a persisted field is a migration in
 * both directions, and Phase 4's React Native client is the next thing that may
 * want a narrower one. What it must never again be is a curated allowlist with
 * no client exercising it — that was `phone`, and it is gone.
 */
export type DeviceRole = 'device';

/** A client the transport will answer, and what it is trusted to be. */
export interface DeviceRecord {
  /** Stable identity across re-rolls; the token is the credential, this is not. */
  id: string;
  /**
   * The bearer token, in plaintext.
   *
   * The reason it was plaintext — re-displaying a pairing QR from the stored
   * token — died with the phone client, so the only thing keeping it readable
   * now is that nothing has needed to hash it yet. Phase 2's one-shot pairing
   * codes are what make hashing free (the token is shown once, at pairing, and
   * never again), and that step replaces this field with `tokenHash`. Until
   * then: 0600 inside a state root that already holds settings.json and pi's
   * auth.json — anything that can read this can read those.
   */
  token: string;
  role: DeviceRole;
  /** Human label, for the device list Phase 2 will grow. */
  label: string;
  createdAt: string;
  /** Last successful authentication, or null if it has never connected. */
  lastSeenAt: string | null;
}

interface DeviceStore {
  version: 1;
  devices: DeviceRecord[];
}

/** In-process copy so the hot path (every /rpc call) doesn't hit the disk. */
let cached: DeviceRecord[] | null = null;
/** Serializes reads and writes, so two first-boot callers can't both mint. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * lastSeenAt is a diagnostic, and the transport authenticates on every request —
 * writing the file per call would turn a hot path into disk I/O for nothing. One
 * write a minute per device is plenty to answer "is this phone still around".
 */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

function newDevice(role: DeviceRole, label: string): DeviceRecord {
  return {
    id: randomBytes(8).toString('hex'),
    token: randomBytes(TOKEN_BYTES).toString('hex'),
    role,
    label,
    createdAt: new Date().toISOString(),
    lastSeenAt: null
  };
}

/** Run `task` after every registry operation already queued. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeDevices(devices: DeviceRecord[]): Promise<void> {
  const path = devicesStorePath();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const store: DeviceStore = { version: 1, devices };
  // `mode` only applies when the file is created, so chmod after the write is
  // what makes a re-roll onto an existing (or umask-widened) file 0600 too.
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  cached = devices;
}

function parseDevices(raw: string): DeviceRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const devices = (parsed as Partial<DeviceStore> | null)?.devices;
  if (!Array.isArray(devices)) return null;
  // A record that isn't well-formed is dropped rather than trusted: a malformed
  // token can only ever lock a device out, and a missing role would be a hole.
  //
  // `phone` records are dropped outright, and that is a security decision rather
  // than tidying. A phone token used to be constrained by an allowlist; with the
  // allowlist gone, honouring one would silently promote it to the full registry
  // — the exact opposite of what pairing a phone once meant. Any phone paired
  // before this release stops working, which is correct: its client no longer
  // exists. `desktop` is carried across as the single surviving role.
  return devices.flatMap((d): DeviceRecord[] => {
    if (!d || typeof d !== 'object') return [];
    const record = d as Omit<DeviceRecord, 'role'> & { role?: unknown };
    if (typeof record.id !== 'string') return [];
    if (typeof record.token !== 'string' || !TOKEN_PATTERN.test(record.token)) return [];
    if (record.role !== 'desktop' && record.role !== 'device') return [];
    return [{ ...record, role: 'device' }];
  });
}

async function loadDevices(): Promise<DeviceRecord[]> {
  if (cached) return cached;
  try {
    const parsed = parseDevices(await readFile(devicesStorePath(), 'utf8'));
    if (parsed) {
      cached = parsed;
      return parsed;
    }
    // Present but unreadable (truncated write, hand-edit): fall through and
    // rebuild rather than lock every device out of a machine nobody can log into.
  } catch {
    // Absent — first boot, or an install from before the registry existed.
  }
  await writeDevices([]);
  return [];
}

/** Every registered device. */
export function readDevices(): Promise<readonly DeviceRecord[]> {
  return enqueue(loadDevices);
}

/**
 * The device holding this role, minting and persisting one on first use. Single
 * record today: the desktop is this machine, minted off shared disk with no
 * pairing step. Phase 2's one-shot codes are what turn this into a list.
 */
export function ensureDevice(role: DeviceRole, label: string): Promise<DeviceRecord> {
  return enqueue(async () => {
    const devices = await loadDevices();
    const existing = devices.find((d) => d.role === role);
    if (existing) return existing;
    const minted = newDevice(role, label);
    await writeDevices([...devices, minted]);
    return minted;
  });
}

/**
 * Mint a fresh token for `role`, invalidating every device using the old one.
 * Keeps the record's id and createdAt: it is the same device slot, re-credentialed.
 */
export function rerollDeviceToken(role: DeviceRole, label: string): Promise<DeviceRecord> {
  return enqueue(async () => {
    const devices = await loadDevices();
    const existing = devices.find((d) => d.role === role);
    const rolled: DeviceRecord = existing
      ? { ...existing, token: randomBytes(TOKEN_BYTES).toString('hex'), lastSeenAt: null }
      : newDevice(role, label);
    await writeDevices([...devices.filter((d) => d !== existing), rolled]);
    return rolled;
  });
}

/**
 * Which device presented this token, or null. Every record is compared even after
 * a match, so the answer takes the same time whichever device called (the loop
 * leaks only how many devices are registered, which is not a secret).
 */
export async function resolveDevice(presented: string | null | undefined): Promise<DeviceRecord | null> {
  const devices = await readDevices();
  let matched: DeviceRecord | null = null;
  for (const device of devices) {
    if (tokenEquals(device.token, presented)) matched = device;
  }
  if (matched) noteDeviceSeen(matched);
  return matched;
}

/** Stamp lastSeenAt, at most once a LAST_SEEN_WRITE_INTERVAL_MS per device. */
function noteDeviceSeen(device: DeviceRecord): void {
  const now = Date.now();
  const last = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
  if (Number.isFinite(last) && now - last < LAST_SEEN_WRITE_INTERVAL_MS) return;
  const seenAt = new Date(now).toISOString();
  void enqueue(async () => {
    const devices = await loadDevices();
    const current = devices.find((d) => d.id === device.id);
    if (!current) return;
    await writeDevices(devices.map((d) => (d === current ? { ...d, lastSeenAt: seenAt } : d)));
    // The caller holds the pre-write object; keep it in step so the throttle
    // above sees the new timestamp without another read.
    device.lastSeenAt = seenAt;
  }).catch(() => undefined);
}

/** Drop the in-process copy (tests; also forces a re-read after an external edit). */
export function forgetCachedDevices(): void {
  cached = null;
}

/**
 * Constant-time token compare. timingSafeEqual THROWS on a length mismatch, so
 * the lengths are compared first — that leaks only the expected token's length,
 * which is a fixed public constant (64 hex characters), not a secret.
 */
export function tokenEquals(expected: string, presented: string | null | undefined): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The token a request presents: `Authorization: Bearer …`, and nothing else.
 *
 * There used to be a `?token=…` fallback, because `EventSource` cannot set
 * request headers and the phone's SSE stream had no other way in. Every
 * remaining client speaks node:http and sets the header on /events like any
 * other request, so the query form had no caller — and it is exactly the shape
 * that would have written a full-admin credential into a reverse proxy's access
 * log the moment Phase 2 puts one in front. Removed while nothing depends on it.
 */
export function presentedToken(headers: IncomingHttpHeaders): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^bearer /i.test(auth)) {
    const value = auth.slice('bearer '.length).trim();
    if (value) return value;
  }
  return null;
}

/** What counts as a hostname Stem can legitimately be reached under. */
export interface OriginPolicy {
  /** The loopback port the server listens on; loopback Hosts must carry it. */
  port: number;
  /** Extra Host values accepted verbatim — an escape hatch for odd proxies. */
  extraHosts?: readonly string[];
}

/**
 * Sec-Fetch-Site values that can't be a cross-site page driving us: `same-origin`
 * is our own client's fetch/EventSource, `none` is a user-initiated navigation
 * (typing the URL, a Home Screen icon). `same-site` and `cross-site` are refused
 * — nothing in the design produces them.
 */
const SAFE_FETCH_SITES = new Set(['same-origin', 'none']);

/** Split `host:port` (handling a bracketed IPv6 literal) into name + port. */
function splitHostPort(host: string): { name: string; port: string | null } {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close === -1) return { name: host, port: null };
    const rest = host.slice(close + 1);
    return { name: host.slice(1, close), port: rest.startsWith(':') ? rest.slice(1) : null };
  }
  const colon = host.lastIndexOf(':');
  if (colon === -1) return { name: host, port: null };
  return { name: host.slice(0, colon), port: host.slice(colon + 1) };
}

function hostAllowed(host: string, policy: OriginPolicy): boolean {
  const lower = host.toLowerCase();
  if (policy.extraHosts?.some((h) => h.toLowerCase() === lower)) return true;
  const { name, port } = splitHostPort(lower);
  if (name === '127.0.0.1' || name === 'localhost' || name === '::1') {
    // A loopback Host must name our port: an attacker's rebound hostname would
    // reach the same socket but arrive under its own name, not this one.
    return port === String(policy.port);
  }
  // MagicDNS names on the tailnet (`<machine>.<tailnet>.ts.net`), which is the
  // only other way in — `tailscale serve` fronts us and nothing else resolves
  // there. The port is unconstrained: serve usually terminates TLS on 443.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name);
}

/**
 * Why this request's origin is untrusted, or null when it is fine. Order matters
 * only for the error message; every check is independent.
 */
export function requestOriginProblem(headers: IncomingHttpHeaders, policy: OriginPolicy): string | null {
  const site = headers['sec-fetch-site'];
  if (typeof site === 'string' && !SAFE_FETCH_SITES.has(site)) {
    return `cross-origin request (Sec-Fetch-Site: ${site})`;
  }
  const host = typeof headers.host === 'string' ? headers.host : '';
  if (!host) return 'missing Host header';
  if (!hostAllowed(host, policy)) return `unexpected Host ${host}`;

  const origin = headers.origin;
  // 'null' is what a sandboxed/opaque origin sends — never one of ours.
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null') return 'opaque Origin';
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return `unparseable Origin ${origin}`;
    }
    if (originHost.toLowerCase() !== host.toLowerCase()) return `Origin ${origin} does not match Host ${host}`;
  }
  return null;
}
