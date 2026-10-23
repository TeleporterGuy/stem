import { catalogEntryFor, catalogServerHost, type McpCatalogEntry } from '../../shared/mcp-app-catalog';
import type { WindowMcpSuggestion } from '../../shared/types';
import type { PiMcpServer } from './mcp-config';

// "Ask about this window": which MCP servers cover the app the user asked
// from. A server's `apps` (Manage → MCP → Works with apps) names them; a
// server that names none is matched by its own name — a server called "slack"
// covers Slack, "linear-mcp" covers Linear — which is how nearly everyone
// names one. The match only steers: the model is told to prefer the server,
// and every other server stays as available as it was.

/** "Linear MCP", "linear-mcp", "mcp_linear" → "linear". */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && w !== 'mcp' && w !== 'server' && w !== 'app')
    .join('');
}

/** Whether a server with this name covers the app, when it names no apps itself. */
function nameMatches(serverName: string, app: string, bundleId: string | null): boolean {
  const server = normalize(serverName);
  if (server.length < 3) return false;
  const appName = normalize(app);
  if (appName && (appName === server || (server.length >= 4 && appName.includes(server)))) return true;
  // com.tinyspeck.slackmacgap → "slack" in its parts.
  return !!bundleId && bundleId.toLowerCase().split('.').some((part) => part === server || (server.length >= 4 && part.startsWith(server)));
}

/** Whether one entry of a server's `apps` names this app: by name or bundle id, any case. */
function listed(entry: string, app: string, bundleId: string | null): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  return e === app.trim().toLowerCase() || (!!bundleId && e === bundleId.toLowerCase());
}

/** A server's own host, for telling it is the catalog's server under another name. */
function serverHost(def: PiMcpServer): string | null {
  const url = (def as { url?: unknown }).url;
  return typeof url === 'string' ? hostOf(url) : null;
}

/**
 * Whether a server covers the window: its "Works with apps" names the app (or,
 * in a browser, the site's catalog name or host); without that list, its name
 * matches the app's, or it is the catalog's own server for the app.
 */
function covers(
  name: string,
  def: PiMcpServer,
  app: string,
  bundleId: string | null,
  entry: McpCatalogEntry | null,
  site: string | null
): boolean {
  if (Array.isArray(def.apps)) {
    return def.apps.some(
      (a) => listed(a, app, bundleId) || (!!entry && listed(a, entry.name, null)) || (!!site && listed(a, site, null))
    );
  }
  if (nameMatches(name, app, bundleId) || (!!entry && nameMatches(name, entry.name, null))) return true;
  const host = entry && catalogServerHost(entry);
  return !!host && serverHost(def) === host;
}

/**
 * The servers that cover this app, by name, in config order. Disabled servers
 * and ones the turn may not see (`allow`, a persona's allowlist; null = all)
 * never match. `url` is a browser window's tab address: the site's servers
 * match too.
 */
export function mcpServersForApp(
  servers: Record<string, PiMcpServer>,
  app: string,
  bundleId: string | null,
  allow: string[] | null,
  url: string | null = null
): string[] {
  const entry = url ? catalogEntryFor(app, bundleId, url) : catalogEntryFor(app, bundleId);
  const site = url ? hostOf(url) : null;
  return Object.entries(servers)
    .filter(([name, def]) => !def.disabled && (allow === null || allow.includes(name)))
    .filter(([name, def]) => covers(name, def, app, bundleId, entry, site))
    .map(([name]) => name);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    // quiet: an address that does not parse names no host, so it matches nothing.
    return null;
  }
}

/**
 * What the window chip offers for the app's official MCP server: nothing when
 * one already covers it (or the app has none Stem knows, or a persona hides
 * the one there is), "turn on" for a covering server that is switched off,
 * else "connect" with the catalog's entry.
 */
export function windowMcpSuggestion(
  servers: Record<string, PiMcpServer>,
  app: string,
  bundleId: string | null,
  url: string | null = null,
  allow: string[] | null = null
): WindowMcpSuggestion | null {
  const entry = catalogEntryFor(app, bundleId, url);
  if (!entry) return null;
  const site = url ? hostOf(url) : null;
  const covering = Object.entries(servers).filter(([name, def]) => covers(name, def, app, bundleId, entry, site));
  if (covering.some(([name, def]) => !def.disabled && (allow === null || allow.includes(name)))) return null;
  // A server there but hidden from this persona: not ours to offer around.
  if (covering.some(([name]) => allow !== null && !allow.includes(name))) return null;
  const off = covering.find(([, def]) => def.disabled);
  if (off) return { kind: 'enable', server: off[0], entry };
  return { kind: 'connect', entry };
}

/** A typed "Works with apps" list, cleaned: trimmed, de-duplicated, no blanks. */
export function cleanAppList(apps: unknown): string[] | null {
  if (apps === null || apps === undefined) return null;
  if (!Array.isArray(apps)) throw new Error('Works with apps must be a list of app names.');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of apps) {
    if (typeof a !== 'string') continue;
    const t = a.trim().slice(0, 200);
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.length ? out : null;
}
