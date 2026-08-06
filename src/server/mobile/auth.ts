import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mobileTokenPath } from '../workspace/paths';

// Who is allowed to talk to the phone bridge. Two independent gates, because the
// bridge is the first Stem surface reachable from off the machine:
//
//   1. A bearer token — 32 random bytes as hex, in its own 0600 file, compared in
//      constant time. Paired by QR from Settings → Mobile, and re-rollable from
//      there too — which is the whole revocation story: one re-roll invalidates
//      every paired phone at once.
//   2. A request-origin check — the DNS-rebinding defense. Without it, any page
//      the phone's browser loads could point a hostname at 127.0.0.1 (or at the
//      tailnet address) and drive /rpc from inside the browser, with the browser
//      happily attaching nothing but its own cookies... and, once it has read a
//      token out of anywhere, everything. Checking the *Host* header against the
//      hostnames Stem can legitimately be reached under is what actually stops
//      rebinding: a matching Origin/Host pair proves nothing, since a rebound
//      attacker controls both.
//
// The static bundle is deliberately NOT token-gated: the token arrives in the URL
// fragment, which browsers never send to the server, so mobile.html has to load
// before the client knows it. The bundle is not a secret; every capability behind
// it is. The origin check still applies to it.

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** In-process copy so the hot path (every /rpc call) doesn't hit the disk. */
let cached: string | null = null;

async function writeToken(token: string): Promise<string> {
  const path = mobileTokenPath();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  // `mode` only applies when the file is created, so chmod after the write is
  // what makes a re-roll onto an existing (or umask-widened) file 0600 too.
  await writeFile(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  cached = token;
  return token;
}

/**
 * The bridge's bearer token, minting and persisting one on first use. A file that
 * exists but doesn't hold a well-formed token (truncated write, hand-edit) is
 * replaced rather than trusted — a malformed token would just lock the phone out.
 */
export async function ensureMobileToken(): Promise<string> {
  if (cached) return cached;
  try {
    const existing = (await readFile(mobileTokenPath(), 'utf8')).trim();
    if (TOKEN_PATTERN.test(existing)) {
      cached = existing;
      return existing;
    }
  } catch {
    // Absent or unreadable — mint a fresh one below.
  }
  return writeToken(randomBytes(TOKEN_BYTES).toString('hex'));
}

/** Mint a new token, invalidating every paired phone. Returns the new token. */
export function rerollMobileToken(): Promise<string> {
  return writeToken(randomBytes(TOKEN_BYTES).toString('hex'));
}

/** Drop the in-process copy (tests; also forces a re-read after an external edit). */
export function forgetCachedMobileToken(): void {
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
