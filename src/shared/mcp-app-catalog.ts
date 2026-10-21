import { MCP_APP_CATALOG } from './mcp-app-catalog-data';

// "Ask about this window": the official MCP servers Stem knows for apps, so a
// window of an app with one can offer to connect it. Only servers the app's own
// vendor publishes (its docs or its GitHub org) are listed — never a community
// server, however popular. The data lives in mcp-app-catalog-data.ts.

export interface McpCatalogEntry {
  /** Stable key ("slack"), also the name a connected server is given. */
  id: string;
  /** The vendor's name for the product ("Slack", "Microsoft 365"). */
  name: string;
  /** The vendor's page that publishes the server. */
  source: string;
  /** How to reach it. A `{placeholder}` in the URL is the user's own (their workspace host). */
  server: { url: string } | { command: string; args: string[] };
  /** oauth = sign in; token = paste an API key; none = nothing; app = talks to the running desktop app. */
  auth: 'oauth' | 'token' | 'none' | 'app';
  /** For auth 'token': the env var (command) or header (URL) the key goes in. */
  tokenEnv?: string;
  /** Must run on the user's own computer (talks to a local app, or is a local command). */
  local?: true;
  /**
   * Sign-in needs an OAuth app the user creates first: the vendor gives no
   * automatic client registration, so the client ID and secret go in the form.
   */
  setup?: { url: string; steps: string };
  /** One line the user should know before connecting (paid plan, work accounts only). */
  note?: string;
  /** Window ids, any platform: macOS bundle ids, Windows exe names (lowercase, no .exe), Linux desktop/Flatpak ids or WM_CLASS. */
  ids?: string[];
  /** App names, matched whole, for a window that came without an id. */
  names?: string[];
  /** Web hosts of the app, each also matching its subdomains ("atlassian.net" covers acme.atlassian.net); "host/path" also needs the path prefix. */
  web?: string[];
}

/** One catalog entry's host name, or null for a command or a templated URL. */
export function catalogServerHost(entry: McpCatalogEntry): string | null {
  if (!('url' in entry.server) || entry.server.url.includes('{')) return null;
  try {
    return new URL(entry.server.url).host.toLowerCase();
  } catch {
    return null;
  }
}

function webMatches(pattern: string, host: string, path: string): boolean {
  const p = pattern.toLowerCase();
  const slash = p.indexOf('/');
  const pHost = (slash === -1 ? p : p.slice(0, slash)).replace(/^\./, '');
  const pPath = slash === -1 ? '' : p.slice(slash);
  const hostOk = host === pHost || host.endsWith(`.${pHost}`);
  return hostOk && (!pPath || path.startsWith(pPath));
}

const byId = new Map<string, McpCatalogEntry>();
for (const e of MCP_APP_CATALOG) for (const id of e.ids ?? []) byId.set(id.toLowerCase(), e);

/**
 * The catalog entry for a window: by its app id, else its exact app name, or —
 * for a browser window, given its tab address — by the site.
 */
export function catalogEntryFor(app: string, bundleId: string | null, url?: string | null): McpCatalogEntry | null {
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const host = parsed.host.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    // The most specific pattern wins: BigQuery's console path over Google Cloud's host.
    let best: { entry: McpCatalogEntry; score: number } | null = null;
    for (const e of MCP_APP_CATALOG)
      for (const w of e.web ?? [])
        if (webMatches(w, host, path) && (!best || w.length > best.score)) best = { entry: e, score: w.length };
    return best?.entry ?? null;
  }
  if (bundleId) {
    const hit = byId.get(bundleId.toLowerCase());
    if (hit) return hit;
  }
  const name = app.trim().toLowerCase();
  if (!name) return null;
  return MCP_APP_CATALOG.find((e) => [e.name, ...(e.names ?? [])].some((n) => n.toLowerCase() === name)) ?? null;
}

export function catalogEntryById(id: string): McpCatalogEntry | null {
  return MCP_APP_CATALOG.find((e) => e.id === id) ?? null;
}
