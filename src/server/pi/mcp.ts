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
  type PiMcpConfig,
  type PiMcpServer
} from './mcp-config';
import { deviceMcpRouter, deviceSpecFor } from '../mcp-device/router';
import { mcpSpecFingerprint } from '../../shared/mcp-fingerprint';
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
  location: PiMcpServer['location'],
  devices: readonly DeviceRecord[]
): McpServerLocation | undefined {
  if (!location) return undefined;
  const device = devices.find((d) => d.id === location.deviceId);
  if (!device) {
    return {
      deviceId: location.deviceId,
      label: 'Unpaired device',
      orphaned: true,
      // The name that machine had when the pin was made, when we have it. This
      // is what turns "Unpaired device" into "was Ada's MacBook" — the single
      // most useful thing to know here, because the commonest way to arrive at
      // this state is re-pairing the very same computer.
      ...(location.label ? { rememberedLabel: location.label } : {})
    };
  }
  return { deviceId: device.id, label: device.label };
}

/**
 * What each device is currently asked to host, as one comparable string per
 * device — the same reading of mcp.json that `assignmentsFor` does, so that
 * "did this change for that machine" cannot answer differently from "what is
 * that machine sent".
 *
 * Disabled entries are left out because they are not sent either: turning a
 * pinned server off IS a change to what its machine hosts, and one that has to
 * reach it, or the child keeps running over there.
 */
function assignmentDigests(servers: Record<string, PiMcpServer>): Map<string, string> {
  const lines = new Map<string, string[]>();
  for (const [name, def] of Object.entries(servers)) {
    const deviceId = def.location?.deviceId;
    if (!deviceId || def.disabled) continue;
    const line = `${name} ${mcpSpecFingerprint(deviceSpecFor(def))}`;
    lines.set(deviceId, [...(lines.get(deviceId) ?? []), line]);
  }
  return new Map([...lines].map(([deviceId, list]) => [deviceId, list.sort().join('\n')]));
}

/**
 * Make one change to mcp.json and tell the machines it changed things for.
 *
 * EVERY mutation goes through here, which is the point. mcp.json is written
 * centrally and read by whichever computer runs the server, and the two are
 * routinely not the same computer — the panel's own edits, the assistant's
 * `add_mcp_server`, a pin changed from a phone or a second desktop all land in
 * the same file and none of them is on the machine that would have to act. A
 * device that is not told keeps a removed server's child alive and keeps running
 * the spec it approved before the args were edited, until its next launch.
 *
 * The renderer's applyMcpChange() is not enough and cannot be made enough: it
 * refreshes the host in the window that made the edit, which is exactly the one
 * machine that is NOT usually the host. This is at the writer, so it holds for
 * every caller including the ones that have no window at all.
 *
 * Which machines are told is decided by diffing the assignments themselves,
 * before and after, inside the same lock the write takes: an edit to a
 * server-located entry wakes nobody, and an edit that moves a server from one
 * machine to another tells both — the one that must stop it and the one that
 * must be offered it.
 */
async function writeServers(
  mutate: (config: PiMcpConfig) => Promise<void> | void
): Promise<McpServerSummary[]> {
  let before = new Map<string, string>();
  let after = new Map<string, string>();
  await withMcpStateMutation(async () => {
    const config = await readMcpConfig();
    before = assignmentDigests(config.servers);
    await mutate(config);
    after = assignmentDigests(config.servers);
    await writeMcpConfig(config);
  });
  // After the lock, never inside it: a push writes to sockets, and the device it
  // reaches answers by calling back in for its assignments — which would want
  // the very lock this is standing in.
  for (const deviceId of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(deviceId) === after.get(deviceId)) continue;
    deviceMcpRouter().assignmentsChanged(deviceId);
  }
  return listMcpServers();
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
): Promise<PiMcpServer['location']> {
  const deviceId = requested?.deviceId?.trim();
  if (!deviceId) return undefined;
  const device = (await readDevices()).find((d) => d.id === deviceId);
  if (!device) throw new Error('That device is not paired with this server any more.');
  if (deviceKind(device) !== 'desktop') {
    throw new Error(
      `“${device.label}” is a phone, and a phone cannot host an MCP server — it goes to sleep, and the server would be unreachable whenever the screen locked.`
    );
  }
  // The label is read from the registry here and never taken from the caller,
  // for the same reason the id is validated here: a caller that could supply it
  // could make a row claim to be a machine it is not. Written alongside the id
  // so that an entry orphaned by a re-pairing can still name the computer it
  // meant — a display fact, never a routing one.
  return { deviceId: device.id, label: device.label };
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

  return writeServers(async (config) => {
    const previous = config.servers[name];
    const identityChanged = !previous || mcpServerAuthIdentity(previous) !== mcpServerAuthIdentity(next);
    // Revoke the name-keyed credential before exposing a new identity. If the
    // config write then fails/crashes, the old server merely needs to sign in
    // again; the secret can never become attached to the new URL.
    if (identityChanged) await deleteOAuthToken(name);
    config.servers[name] = next;
  });
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
  return writeServers((config) => {
    const def = config.servers[name];
    if (!def) throw new Error(`No MCP server named "${name}".`);
    // Deleted rather than written as undefined/null: absent is what "runs where
    // stem-server runs" has always looked like on disk, and an entry moved back
    // has to be byte-identical to one that was never pinned.
    if (location) def.location = location;
    else delete def.location;
  });
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
  return writeServers((config) => {
    const def = config.servers[name];
    if (!def) throw new Error(`No MCP server named "${name}".`);
    if (enabled) delete def.disabled;
    else def.disabled = true;
  });
}

export async function removeMcpServer(name: string): Promise<McpServerSummary[]> {
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is a reserved Stem server name.`);
  return writeServers(async (config) => {
    if (!config.servers[name]) throw new Error(`No MCP server named "${name}".`);
    // Delete the credential first for the same fail-safe ordering as replacement.
    await deleteOAuthToken(name);
    delete config.servers[name];
  });
}
