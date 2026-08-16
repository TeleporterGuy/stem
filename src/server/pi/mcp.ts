import type { McpServerInput, McpServerLocation, McpServerSummary } from '../../shared/types';
import { deviceKind, readDevices, type DeviceRecord } from '../transport/auth';
import {
  readMcpConfig,
  writeMcpConfig,
  deleteOAuthToken,
  readOAuthTokens,
  mcpServerAuthIdentity,
  oauthTokenMatchesServer,
  withMcpStateMutation,
  type PiMcpServer
} from './mcp-config';
import { RECALL_MCP_NAME } from '../recall/register-mcp';
import { ADMIN_MCP_NAME } from '../admin/register-mcp';

// User-facing MCP add/remove/list for the pi backend, operating on mcp.json. The
// bridge extension (stem-mcp-extension.mjs) reads this file on (re)start; the
// renderer calls restartRuntime() after a change so the bridge reconnects.

/**
 * Internal, Stem-owned servers hidden from the user-facing MCP list. They are
 * also the servers that always run where stem-server runs: both reach into state
 * only that machine has (recall's database, the config the admin server edits),
 * so nothing here ever writes them a `location`.
 */
const RESERVED_NAMES = new Set([RECALL_MCP_NAME, ADMIN_MCP_NAME]);
const VALID_NAME = /^[A-Za-z0-9_.-]+$/;

function assertValidName(name: string): void {
  if (!VALID_NAME.test(name) || name.startsWith('-')) {
    throw new Error(
      'MCP server name may only contain letters, numbers, dot, dash, or underscore, and cannot start with a dash.'
    );
  }
}

/**
 * How a stored `location` should render, or undefined for a server that runs
 * where stem-server runs. A deviceId that is no longer in the registry is
 * reported as orphaned rather than dropped or silently rewritten to "here": the
 * entry names a machine that was unpaired, and saying so is the only honest
 * answer (docs/mcp-device-pinning.md, ⑩).
 */
function describeLocation(
  location: { deviceId: string } | undefined,
  devices: readonly DeviceRecord[]
): McpServerLocation | undefined {
  if (!location) return undefined;
  const device = devices.find((d) => d.id === location.deviceId);
  if (!device) return { deviceId: location.deviceId, label: 'Unpaired device', orphaned: true };
  return { deviceId: device.id, label: device.label };
}

export async function listMcpServers(): Promise<McpServerSummary[]> {
  const config = await readMcpConfig();
  const oauth = await readOAuthTokens();
  const devices = await readDevices();
  return Object.entries(config.servers)
    .filter(([name]) => !RESERVED_NAMES.has(name))
    .map(([name, def]) => {
      const url = def.url ?? '';
      // Populate `auth_status` so the panel shows the right state before the
      // bridge reports live connection status: a stored OAuth token or a static
      // auth header both count as credentials-on-disk.
      const hasHeaderAuth = !!def.headers && Object.keys(def.headers).length > 0;
      const authStatus = url
        ? oauthTokenMatchesServer(oauth[name], def)
          ? 'o_auth'
          : hasHeaderAuth
            ? 'bearer_token'
            : def.oauthClientId
              ? 'o_auth' // static OAuth client configured but not yet signed in
              : undefined
        : undefined;
      return {
        name,
        transport: url ? 'http' : 'stdio',
        command: def.command ?? '',
        args: Array.isArray(def.args) ? def.args : [],
        url,
        authStatus,
        enabled: !def.disabled,
        ...(def.location ? { location: describeLocation(def.location, devices) } : {})
      } satisfies McpServerSummary;
    });
}

/**
 * Validate a requested location against the device registry, returning what
 * should go in `mcp.json` (or undefined for the server's own machine).
 *
 * Both refusals happen here, at the one moment a person is watching: an unknown
 * device would write an entry that is orphaned the second it is saved, and a
 * phone would be pinned as a host it can never usefully be — iOS suspends the
 * app, and availability is "has an open stream" (docs/mcp-device-pinning.md, ⑦).
 */
async function resolveLocation(
  requested: { deviceId: string } | undefined
): Promise<{ deviceId: string } | undefined> {
  const deviceId = requested?.deviceId?.trim();
  if (!deviceId) return undefined;
  const device = (await readDevices()).find((d) => d.id === deviceId);
  if (!device) throw new Error('That device is not paired with this server any more.');
  if (deviceKind(device) !== 'desktop') {
    throw new Error(
      `“${device.label}” is a phone, and a phone cannot host an MCP server — it goes to sleep, and the server would be unreachable whenever the screen locked.`
    );
  }
  return { deviceId: device.id };
}

export async function addMcpServer(input: McpServerInput): Promise<McpServerSummary[]> {
  const name = input.name.trim();
  if (!name) throw new Error('MCP server requires a name.');
  assertValidName(name);
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is a reserved Stem server name.`);
  const location = await resolveLocation(input.location);

  let next: PiMcpServer;
  if (input.transport === 'http') {
    const url = input.url?.trim();
    if (!url) throw new Error('A remote MCP server requires a URL.');
    const headers = input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined;
    // Optional static OAuth client (for providers without dynamic registration,
    // e.g. Slack). Stored alongside the server; mcpLogin runs the confidential-
    // client flow when a client id is present.
    const oauthClientId = input.oauthClientId?.trim() || undefined;
    const oauthClientSecret = input.oauthClientSecret?.trim() || undefined;
    const oauthScope = input.oauthScope?.trim() || undefined;
    // A user explicitly adding a server implies trust → its tools run without a
    // per-call confirmation (standard MCP-host behavior).
    next = {
      url,
      ...(headers ? { headers } : {}),
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(oauthClientSecret ? { oauthClientSecret } : {}),
      ...(oauthScope ? { oauthScope } : {}),
      trusted: true
    };
  } else {
    const command = input.command?.trim();
    if (!command) throw new Error('A local MCP server requires a command.');
    const env = input.env && Object.keys(input.env).length > 0 ? input.env : undefined;
    next = { command, args: input.args ?? [], ...(env ? { env } : {}), trusted: true };
  }
  if (location) next = { ...next, location };

  await withMcpStateMutation(async () => {
    const config = await readMcpConfig();
    const previous = config.servers[name];
    const identityChanged = !previous || mcpServerAuthIdentity(previous) !== mcpServerAuthIdentity(next);
    // Revoke the name-keyed credential before exposing a new identity. If the
    // config write then fails/crashes, the old server merely needs to sign in
    // again; the secret can never become attached to the new URL.
    if (identityChanged) await deleteOAuthToken(name);
    config.servers[name] = next;
    await writeMcpConfig(config);
  });
  return listMcpServers();
}

/**
 * Move a server to another machine, or back to the one hosting stem-server —
 * the *Move to <device>* the panel offers on a server-located entry and on an
 * orphaned one (docs/mcp-device-pinning.md, ⑩).
 *
 * Shaped like setMcpServerEnabled rather than like addMcpServer, and for the
 * same reason: it edits ONE field of an entry that already exists. A move built
 * out of what the panel can see would be a different server — `listMcpServers`
 * returns no `env` and no headers, so re-adding from the row would drop every
 * credential the entry had.
 *
 * Two things it deliberately does not do. It does not touch the OAuth token:
 * `location` is outside {@link mcpServerAuthIdentity} on purpose (see
 * mcp-config.ts), so moving a server does not change who it authenticates as and
 * the stored token is still that server's. And it cannot carry an approval to
 * the new machine — approvals live on the computer that would run the command
 * (src/desktop/mcp-host/approvals.ts), so the target meets the card and decides
 * there. Nothing on this side can spend that decision for it.
 */
export async function setMcpServerLocation(
  name: string,
  deviceId: string | null
): Promise<McpServerSummary[]> {
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is a reserved Stem server name.`);
  // Validated before the mutation is taken, so the same two refusals a person
  // meets when adding — an unpaired device, a phone — are the ones they meet
  // when moving, in the same words.
  const location = await resolveLocation(deviceId ? { deviceId } : undefined);
  await withMcpStateMutation(async () => {
    const config = await readMcpConfig();
    const def = config.servers[name];
    if (!def) throw new Error(`No MCP server named "${name}".`);
    // Deleted rather than written as undefined/null: absent is what "runs where
    // stem-server runs" has always looked like on disk, and an entry moved back
    // has to be byte-identical to one that was never pinned.
    if (location) def.location = location;
    else delete def.location;
    await writeMcpConfig(config);
  });
  return listMcpServers();
}

/**
 * `input` carrying the pin the stored entry already has, when the caller named
 * no location of its own.
 *
 * For the assistant's `add_mcp_server`, which is the one caller that CANNOT name
 * one: there is no `location` in its schema (deliberately — where a server runs
 * is a decision a person makes at a panel, not one a tool call makes). An add
 * replaces the whole entry, so without this, re-adding a server that runs on
 * your Mac would move it back to the machine hosting stem-server — silently, in
 * the middle of a change the user approved for an entirely different reason,
 * which is precisely what ⑩ says must never happen.
 *
 * Not folded into addMcpServer: a person adding the same name from the panel
 * with "Runs on: Server" picked has said where it goes, and that answer must win.
 */
export async function withStoredLocation(input: McpServerInput): Promise<McpServerInput> {
  if (input.location) return input;
  const existing = (await readMcpConfig()).servers[input.name.trim()];
  return existing?.location ? { ...input, location: { ...existing.location } } : input;
}

/**
 * Toggle a server on/off without removing it. A disabled server stays in
 * `mcp.json` (and keeps its OAuth token) but the bridge skips connecting it
 * (`stem-mcp-extension.mjs`: `if (spec.disabled) continue;`). Re-enabling deletes
 * the key rather than writing `disabled:false`, keeping the file minimal.
 */
export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<McpServerSummary[]> {
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is a reserved Stem server name.`);
  await withMcpStateMutation(async () => {
    const config = await readMcpConfig();
    const def = config.servers[name];
    if (!def) throw new Error(`No MCP server named "${name}".`);
    if (enabled) delete def.disabled;
    else def.disabled = true;
    await writeMcpConfig(config);
  });
  return listMcpServers();
}

export async function removeMcpServer(name: string): Promise<McpServerSummary[]> {
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is a reserved Stem server name.`);
  await withMcpStateMutation(async () => {
    const config = await readMcpConfig();
    if (!config.servers[name]) throw new Error(`No MCP server named "${name}".`);
    // Delete the credential first for the same fail-safe ordering as replacement.
    await deleteOAuthToken(name);
    delete config.servers[name];
    await writeMcpConfig(config);
  });
  return listMcpServers();
}
