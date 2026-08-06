import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { devicesStorePath, mobileTokenPath } from '../workspace/paths';
import type { DeviceRole } from './roles';

// Who is allowed to talk to the transport. Two independent gates, because the
// transport is the first Stem surface reachable from off the machine:
//
//   1. A bearer token — 32 random bytes as hex, held in the device registry
//      (devices.json, 0600) and compared in constant time. A phone pairs by QR
//      from Settings → Mobile and can be re-rolled from there, which is the whole
//      revocation story: one re-roll invalidates every paired phone at once.
//      The desktop's own record is minted by the server at first boot and read
//      straight off the state root — same machine, same trust boundary, so there
//      is no pairing step and no QR.
//   2. A request-origin check — the DNS-rebinding defense. Without it, any page
//      the phone's browser loads could point a hostname at 127.0.0.1 (or at the
//      tailnet address) and drive /rpc from inside the browser, with the browser
//      happily attaching nothing but its own cookies... and, once it has read a
//      token out of anywhere, everything. Checking the *Host* header against the
//      hostnames Stem can legitimately be reached under is what actually stops
//      rebinding: a matching Origin/Host pair proves nothing, since a rebound
//      attacker controls both. It applies to every role, desktop included.
//
// The static bundle is deliberately NOT token-gated: the token arrives in the URL
// fragment, which browsers never send to the server, so mobile.html has to load
// before the client knows it. The bundle is not a secret; every capability behind
// it is. The origin check still applies to it.

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** A client the transport will answer, and what it is trusted to be. */
export interface DeviceRecord {
  /** Stable identity across re-rolls; the token is the credential, this is not. */
  id: string;
  /**
   * The bearer token, in plaintext.
   *
   * Deliberate, not an oversight. Settings → Mobile re-displays the pairing QR
   * from the stored token whenever the user opens it, so a hash would mean the
   * only way to ever see a pairing code again is to re-roll — i.e. un-pairing
   * every phone in order to pair one. The file is 0600 inside the state root,
   * which already holds settings.json (every API key the user has typed) and pi's
   * auth.json: anything that can read this can read those. Phase 2 revisits it
   * alongside real pairing UX, where a one-shot code makes hashing free.
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

function newDevice(role: DeviceRole, label: string, token?: string): DeviceRecord {
  return {
    id: randomBytes(8).toString('hex'),
    token: token ?? randomBytes(TOKEN_BYTES).toString('hex'),
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
  return devices.filter(
    (d): d is DeviceRecord =>
      !!d &&
      typeof d === 'object' &&
      typeof (d as DeviceRecord).id === 'string' &&
      typeof (d as DeviceRecord).token === 'string' &&
      TOKEN_PATTERN.test((d as DeviceRecord).token) &&
      ((d as DeviceRecord).role === 'desktop' || (d as DeviceRecord).role === 'phone')
  );
}

/**
 * The pre-registry phone token, if this install has one. Reading it is the whole
 * migration: an existing mobile.token becomes a `phone` device record on the very
 * first read of devices.json, so a phone paired before the split keeps working
 * with the token already on it and never sees a pairing prompt.
 */
async function migratedPhoneToken(): Promise<string | null> {
  try {
    const existing = (await readFile(mobileTokenPath(), 'utf8')).trim();
    return TOKEN_PATTERN.test(existing) ? existing : null;
  } catch {
    return null;
  }
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
  const legacy = await migratedPhoneToken();
  const devices = legacy ? [newDevice('phone', 'Paired phone', legacy)] : [];
  await writeDevices(devices);
  return devices;
}

/** Every registered device. */
export function readDevices(): Promise<readonly DeviceRecord[]> {
  return enqueue(loadDevices);
}

/**
 * The device holding this role, minting and persisting one on first use. Both
 * roles are single-record today: the desktop is this machine, and the phone
 * record is shared by every paired phone (re-rolling it un-pairs all of them at
 * once, which is the documented revocation story). Phase 2's pairing UX is what
 * turns either into a list.
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

/** The phone's bearer token, minting the record on first use. */
export async function ensurePhoneToken(): Promise<string> {
  return (await ensureDevice('phone', 'Paired phone')).token;
}

/** Mint a new phone token, invalidating every paired phone. */
export async function rerollPhoneToken(): Promise<string> {
  return (await rerollDeviceToken('phone', 'Paired phone')).token;
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
 * The token a request presents, from `Authorization: Bearer …` or `?token=…`.
 *
 * The query form exists because `EventSource` cannot set request headers — the
 * SSE stream has no other way to authenticate. It never leaves the loopback hop
 * plus the tailnet's TLS tunnel, and it is not logged (server/log.ts records
 * channels and problems, never URLs).
 */
export function presentedToken(headers: IncomingHttpHeaders, url: string | undefined): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^bearer /i.test(auth)) {
    const value = auth.slice('bearer '.length).trim();
    if (value) return value;
  }
  try {
    // Base is a placeholder: request URLs are always origin-relative here.
    return new URL(url ?? '/', 'http://127.0.0.1').searchParams.get('token');
  } catch {
    return null;
  }
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
