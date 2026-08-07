// Where an OAuth flow expects its browser to come back to.
//
// Every loopback OAuth flow Stem runs — pi's provider logins, Stem's own MCP
// authorization — announces the address it is listening on inside the
// authorization URL it asks the user to visit, as the `redirect_uri` parameter.
// That is the whole reason the callback courier needs no table of ports: the
// flow already said where it will be, and both halves of the courier read it
// from the same string.
//
// Shared because both halves must agree character for character. The server
// records what it advertised; the client binds what it was told; a delivery is
// matched back against the record. Two parsers would be two chances to disagree
// about, say, whether `localhost` and `127.0.0.1` are the same address — and the
// symptom of disagreeing is a sign-in that hangs with no error anywhere.

/** A loopback callback address, normalized to something bindable. */
export interface LoopbackRedirect {
  /** A literal address, never a name: `127.0.0.1`, `127.0.0.2`, `::1`. */
  host: string;
  port: number;
  /** The path the provider will call back on. No query, no fragment. */
  path: string;
  /** The redirect exactly as the provider was given it — the courier's key. */
  redirectUri: string;
}

/** The same, plus the flow's `state` when the authorization URL carried one. */
export interface LoopbackFlow extends LoopbackRedirect {
  /** The value the provider must echo back. Null when the flow uses none. */
  state: string | null;
}

/**
 * Resolve a hostname to the loopback literal it names, or null if it names
 * something else. `localhost` is folded to 127.0.0.1 deliberately: a browser may
 * resolve the name to either family, but every listener in play here — pi's, the
 * MCP flow's, the courier's — binds the v4 literal, which is the combination
 * that has always worked in practice on the platforms Stem runs on.
 */
function loopbackAddress(hostname: string): string | null {
  const name = hostname.toLowerCase();
  if (name === 'localhost') return '127.0.0.1';
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return name;
  // node's URL keeps IPv6 hosts in brackets; callers want the bare address.
  if (name === '[::1]' || name === '::1') return '::1';
  return null;
}

/** Whether a `Host:` header (or any `host:port` pair) names this machine. */
export function isLoopbackHost(header: string | undefined): boolean {
  if (!header) return false;
  // `[::1]:1234` → `[::1]`; `127.0.0.1:1234` → `127.0.0.1`.
  const bare = header.startsWith('[') ? header.slice(0, header.indexOf(']') + 1) : header.split(':')[0];
  return loopbackAddress(bare) !== null;
}

/**
 * Parse a `redirect_uri` on its own. Returns null for anything that is not a
 * plain-HTTP loopback address — a provider-hosted redirect is somebody else's
 * business, and an `https` loopback URL is not something either half of the
 * courier could serve without a certificate.
 */
export function loopbackRedirectUri(raw: string): LoopbackRedirect | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  const host = loopbackAddress(url.hostname);
  if (!host) return null;
  // An omitted port is 80 — legal, and a bind that will fail for want of
  // privileges rather than a shape worth refusing here.
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, path: url.pathname || '/', redirectUri: raw };
}

/**
 * Pull the loopback callback out of an authorization URL, with the `state` the
 * provider will echo back beside it. Null when the URL names no loopback
 * redirect — a device-code flow, a provider-hosted redirect, or a URL that is
 * not one at all.
 */
export function loopbackFlow(authUrl: string): LoopbackFlow | null {
  let url: URL;
  try {
    url = new URL(authUrl);
  } catch {
    return null;
  }
  const redirect = url.searchParams.get('redirect_uri');
  if (!redirect) return null;
  const target = loopbackRedirectUri(redirect);
  if (!target) return null;
  return { ...target, state: url.searchParams.get('state') };
}

/** Identity of a callback address: what a delivery is matched against. */
export function redirectKey(target: LoopbackRedirect): string {
  return `${target.host}:${target.port}${target.path}`;
}
