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

/**
 * The servers that cover this app, by name, in config order. Disabled servers
 * and ones the turn may not see (`allow`, a persona's allowlist; null = all)
 * never match.
 */
export function mcpServersForApp(
  servers: Record<string, PiMcpServer>,
  app: string,
  bundleId: string | null,
  allow: string[] | null
): string[] {
  return Object.entries(servers)
    .filter(([name, def]) => !def.disabled && (allow === null || allow.includes(name)))
    .filter(([name, def]) =>
      Array.isArray(def.apps) ? def.apps.some((entry) => listed(entry, app, bundleId)) : nameMatches(name, app, bundleId)
    )
    .map(([name]) => name);
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
