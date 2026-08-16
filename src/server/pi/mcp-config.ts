import { host } from '../host';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedSocketPath, folderIndexDir, piHome, piMcpConfigPath, recallDbPath } from '../workspace/paths';
import { RECALL_MCP_NAME, recallMcpServerPath } from '../recall/register-mcp';
import { getEmbedEndpointToken } from '../recall/embed-endpoint';
import type { OAuthToken } from './oauth';
import {
  ENV_MCP_OAUTH,
  MCP_OAUTH_FILE,
  NATIVE_SEARCH_GATE_FILE,
  SECRET_ENVELOPE_KEY,
  SERVICE_TIER_GATE_FILE
} from './protocol';
import { decryptSecretValue, encryptSecretValue, secretKeyAvailable } from './secrets';

// Stem's MCP config for the pi backend (mcp.json). Consumed by the bridge
// extension (stem-mcp-extension.mjs), which pi loads via `-e`. Stem owns this file
// end-to-end under the isolated pi home.

export interface PiMcpServer {
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** remote transport (HTTP/OAuth) — recognized but not yet connected by the bridge */
  url?: string;
  headers?: Record<string, string>;
  /**
   * Static OAuth client for remote servers that lack dynamic client registration
   * (e.g. Slack). When `oauthClientId` is present, mcpLogin runs the confidential-
   * client code flow instead of auto-registering. `oauthScope` is the requested
   * scope string (verbatim); the secret is needed because these servers are
   * confidential clients (`client_secret_post`).
   */
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthScope?: string;
  /** Stem-internal servers run without per-call confirmation. */
  trusted?: boolean;
  disabled?: boolean;
  /**
   * Where this server runs. Absent = the machine hosting stem-server, which is
   * what every entry has always meant and still means — so an existing mcp.json
   * round-trips byte for byte and nothing changes for it.
   *
   * The device is named (`devices.json`), never inferred from wherever you
   * happened to be typing: what "my computer" means has to be readable from the
   * config. Only desktops may be named — see the kind check in mcp.ts.
   *
   * Deliberately outside {@link mcpServerAuthIdentity}: moving a server between
   * machines does not change WHO it authenticates as, and folding it into that
   * hash would invalidate every stored OAuth token the moment this field lands.
   */
  location?: { deviceId: string };
}

export interface PiMcpConfig {
  servers: Record<string, PiMcpServer>;
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function mainRuntimeAssetPath(rel: string): string {
  const built = join(__dirname, rel);
  return existsSync(built) ? built : join(host().appRoot(), 'src', 'server', rel);
}

/** Absolute path to the bridge extension asset (mirrors recallMcpServerPath's basis). */
export function piExtensionPath(): string {
  return mainRuntimeAssetPath(join('pi', 'stem-mcp-extension.mjs'));
}

/** Where the bridge writes live connection status (next to mcp.json). */
export function piMcpStatusPath(): string {
  return join(piHome(), 'mcp-status.json');
}

/** Where the bridge writes the routed-tools names+signatures catalog (next to mcp.json). */
export function piMcpCatalogPath(): string {
  return join(piHome(), 'mcp-catalog.json');
}

// mtime-cached read of the routed-tools catalog. The file is static per pi-process
// lifetime (rewritten only when the bridge reconnects on a runtime restart), so we
// re-parse it only when its mtime changes rather than on every turn.
let catalogCache: { mtime: number; text: string } = { mtime: -1, text: '' };

/**
 * The per-turn "Available tools" block, injected alongside the files listing. Lists
 * routed MCP servers' tools as name + 1-line description + compact signature — the
 * heavy input schemas are deferred and fetched on demand via the bridge's
 * describe_tool. Returns null when no routed servers are connected (nothing to add).
 */
export function buildMcpCatalogContext(): string | null {
  let text: string;
  try {
    const mtime = statSync(piMcpCatalogPath()).mtimeMs;
    if (mtime !== catalogCache.mtime) {
      const data = JSON.parse(readFileSync(piMcpCatalogPath(), 'utf8')) as { text?: string };
      catalogCache = { mtime, text: typeof data.text === 'string' ? data.text : '' };
    }
    text = catalogCache.text;
  } catch {
    catalogCache = { mtime: -1, text: '' };
    return null; // missing/corrupt → nothing to inject
  }
  if (!text.trim()) return null;
  return (
    `Available tools (extra MCP servers, beyond your built-in file tools):\n${text}\n\n` +
    `To use any of these, call \`invoke_tool\` with the server name, the exact tool name, and an \`args\` object. ` +
    `The signatures above are compact — if a tool's arguments aren't obvious, call \`describe_tool\` first to get ` +
    `its full input schema. Do not invent servers or tools that aren't listed here.`
  );
}

/**
 * Per-turn gate the bridge reads to decide whether the vendored pi-web-access
 * search tools are active for this turn. The main process rewrites it just before
 * each prompt with the originating context's setting (main vs Quick Chat), since
 * both share one pi process and the hooks can't tell them apart. Carries no
 * credentials, so a plain (non-secret) file is fine.
 *
 * The file keeps its `native-search.json` name from when search WAS the provider's
 * own server-side tool: renaming it would strand the file in every existing pi
 * home for no behavioral gain.
 */
export function piNativeSearchPath(): string {
  return join(piHome(), NATIVE_SEARCH_GATE_FILE);
}

/** Write the `{ enabled }` web-search gate the bridge reads for the next turn. */
export async function writeNativeSearchGate(enabled: boolean): Promise<void> {
  await mkdir(piHome(), { recursive: true });
  await writeFile(piNativeSearchPath(), JSON.stringify({ enabled }, null, 2), 'utf8');
}

/**
 * Per-turn gate the bridge's service-tier hook reads to decide whether to inject the
 * OpenAI `service_tier` field on the next request. Like the web-search gate, the main
 * process rewrites it just before each prompt (main vs Quick Chat share one pi process).
 */
export function piServiceTierPath(): string {
  return join(piHome(), SERVICE_TIER_GATE_FILE);
}

/** Write the `{ tier }` gate: 'priority' = Fast; null = Standard (omit service_tier). */
export async function writeServiceTierGate(tier: string | null): Promise<void> {
  await mkdir(piHome(), { recursive: true });
  await writeFile(piServiceTierPath(), JSON.stringify({ tier }, null, 2), 'utf8');
}

/**
 * OAuth tokens for remote MCP servers, keyed by server name. Written by
 * PiRuntime.mcpLogin after a browser sign-in; the bridge reads it to inject the
 * bearer header and rewrites it when it refreshes an expired token.
 */
export function piMcpOAuthPath(): string {
  return process.env[ENV_MCP_OAUTH] ?? join(piHome(), MCP_OAUTH_FILE);
}

export async function readOAuthTokens(): Promise<Record<string, OAuthToken>> {
  return (await readOAuthTokensWithFormat()).tokens;
}

/**
 * Read the token map, reporting whether it was already encrypted at rest so the
 * boot migration can rewrite legacy plaintext files. An encrypted envelope that
 * no longer decrypts (lost/rotated key) reads as empty: the affected servers
 * come up 401 and the user signs in again — never a crash, never ciphertext
 * sent upstream as a bearer token.
 */
async function readOAuthTokensWithFormat(): Promise<{
  tokens: Record<string, OAuthToken>;
  encryptedAtRest: boolean;
}> {
  try {
    const parsed = JSON.parse(await readFile(piMcpOAuthPath(), 'utf8')) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const envelope = parsed[SECRET_ENVELOPE_KEY];
      if (typeof envelope === 'string') {
        const plain = decryptSecretValue(envelope);
        if (plain === null) return { tokens: {}, encryptedAtRest: true };
        const inner = JSON.parse(plain) as Record<string, OAuthToken>;
        return { tokens: inner && typeof inner === 'object' ? inner : {}, encryptedAtRest: true };
      }
      return { tokens: parsed as unknown as Record<string, OAuthToken>, encryptedAtRest: false };
    }
  } catch {
    // missing/corrupt → none
  }
  return { tokens: {}, encryptedAtRest: false };
}

/** Persist the token map, encrypted as a whole-file envelope when the key exists. */
async function writeOAuthTokensFile(all: Record<string, OAuthToken>): Promise<void> {
  const data = secretKeyAvailable()
    ? JSON.stringify({ [SECRET_ENVELOPE_KEY]: encryptSecretValue(JSON.stringify(all)) }, null, 2)
    : JSON.stringify(all, null, 2);
  await writeSecretFile(piMcpOAuthPath(), data);
}

/**
 * Write a credential-bearing file owner-only (0600) in an owner-only dir (0700).
 * mcp.json may carry bearer headers and mcp-oauth.json holds OAuth tokens, so
 * neither should be group/world-readable. The explicit chmod also tightens a
 * file that already exists with looser perms (the `mode` create-option is
 * ignored when the file is merely truncated).
 *
 * The write is atomic: data goes to a sibling temp file that is then renamed over
 * the target. A crash or force-quit mid-write can therefore only leave a stray
 * `.tmp` (harmlessly overwritten next time) — never a truncated mcp.json, which
 * used to read back as corrupt and get reset to an empty server list, silently
 * dropping every user-added server.
 */
async function writeSecretFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path); // atomic on the same filesystem (same dir)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

let oauthMutationTail: Promise<void> = Promise.resolve();
let mcpStateMutationTail: Promise<void> = Promise.resolve();

const FILE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_WAIT_MS = 15_000;

/** Only one waiter may reap an abandoned lock. Without this tiny secondary
 * lock, two waiters can both decide the old inode is stale and the slower one
 * can accidentally unlink the faster waiter's newly-acquired lock. */
async function reapAbandonedLock(lockPath: string): Promise<boolean> {
  const reaperPath = `${lockPath}.reaper`;
  let reaper: Awaited<ReturnType<typeof open>>;
  try {
    reaper = await open(reaperPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs <= FILE_LOCK_STALE_MS) return false;
    } catch {
      return true;
    }
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await reaper.close().catch(() => undefined);
    await rm(reaperPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Cross-process, owner-tagged lock used by main and the MCP bridge. The owner
 * check matters when recovering an abandoned lock: an old owner must never
 * unlink a successor's lock from its `finally` block.
 */
async function withOwnedFileLock<T>(
  lockPath: string,
  timeoutMessage: string,
  operation: () => Promise<T>
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + FILE_LOCK_WAIT_MS;
  const owner = `${process.pid}:${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(owner, 'utf8');
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        handle = undefined;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS) {
          if (await reapAbandonedLock(lockPath)) continue;
        }
      } catch {
        continue; // it disappeared between open/stat; retry immediately
      }
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    const currentOwner = await readFile(lockPath, 'utf8').catch(() => '');
    if (currentOwner === owner) await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function withOAuthFileLock<T>(operation: () => Promise<T>): Promise<T> {
  return withOwnedFileLock(
    `${piMcpOAuthPath()}.lock`,
    'Timed out waiting to update MCP OAuth credentials.',
    operation
  );
}

/**
 * Serialize changes whose security invariant spans both mcp.json and its token
 * map. The bridge uses the same `.state.lock` path before persisting refreshes.
 */
export async function withMcpStateMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mcpStateMutationTail;
  let release!: () => void;
  mcpStateMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await withOwnedFileLock(
      `${piMcpConfigPath()}.state.lock`,
      'Timed out waiting to update MCP configuration.',
      operation
    );
  } finally {
    release();
  }
}

async function serializeOAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = oauthMutationTail;
  let release!: () => void;
  oauthMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await withOAuthFileLock(operation);
  } finally {
    release();
  }
}

export async function saveOAuthToken(name: string, token: OAuthToken): Promise<void> {
  await serializeOAuthMutation(async () => {
    const all = await readOAuthTokens();
    all[name] = token;
    await writeOAuthTokensFile(all);
  });
}

export async function deleteOAuthToken(name: string): Promise<void> {
  await serializeOAuthMutation(async () => {
    const all = await readOAuthTokens();
    if (!(name in all)) return;
    delete all[name];
    await writeOAuthTokensFile(all);
  });
}

/** Delete only the credential snapshot the caller inspected, never a newer login. */
export async function deleteOAuthTokenIfMatches(name: string, expected: OAuthToken): Promise<boolean> {
  return serializeOAuthMutation(async () => {
    const all = await readOAuthTokens();
    if (!all[name] || JSON.stringify(all[name]) !== JSON.stringify(expected)) return false;
    delete all[name];
    await writeOAuthTokensFile(all);
    return true;
  });
}

/** Stable identity determining whether a stored OAuth token may be reused. */
export function mcpServerAuthIdentity(server: PiMcpServer | undefined): string | null {
  if (!server?.url) return null;
  const headers = server.headers
    ? Object.fromEntries(Object.entries(server.headers).sort(([a], [b]) => a.localeCompare(b)))
    : null;
  const serialized = JSON.stringify([
    server.url,
    headers,
    server.oauthClientId ?? null,
    server.oauthClientSecret ?? null,
    server.oauthScope ?? null
  ]);
  return createHash('sha256').update(serialized).digest('hex');
}

/** True only for identity-stamped tokens; legacy name-only records are unsafe. */
export function oauthTokenMatchesServer(token: OAuthToken | undefined, server: PiMcpServer | undefined): boolean {
  const identity = mcpServerAuthIdentity(server);
  return !!identity && !!token?.serverIdentity && token.serverIdentity === identity;
}

/**
 * One-time repair for tokens saved before the identity stamp existed: they lack
 * `serverIdentity`, so the bridge (correctly) refuses to attach them and every
 * previously-signed-in remote server comes up 401 until the user re-logs-in.
 * Stamping them with the CURRENT identity of the server they're keyed to grants
 * exactly the trust they had when saved — the name-keyed binding — without
 * weakening the stamp check for anything saved afterwards. Tokens whose server no
 * longer exists (or is stdio) are left untouched, as are already-stamped tokens,
 * including mismatched ones (a repointed server must force a fresh login).
 */
export async function migrateLegacyOAuthTokens(): Promise<void> {
  await withMcpStateMutation(async () => {
    const config = await readMcpConfig();
    await serializeOAuthMutation(async () => {
      const { tokens: all, encryptedAtRest } = await readOAuthTokensWithFormat();
      // A plaintext legacy file gets rewritten encrypted even when no stamp
      // changes — this is the one-time encrypt-at-rest migration.
      let changed = !encryptedAtRest && Object.keys(all).length > 0 && secretKeyAvailable();
      for (const [name, token] of Object.entries(all)) {
        if (token.serverIdentity) continue;
        const identity = mcpServerAuthIdentity(config.servers[name]);
        if (!identity) continue;
        all[name] = { ...token, serverIdentity: identity };
        changed = true;
      }
      if (changed) await writeOAuthTokensFile(all);
    });
  });
}

/** Persist a completed browser login only if its server identity is still current. */
export async function saveOAuthTokenIfServerMatches(
  name: string,
  expectedIdentity: string,
  token: OAuthToken
): Promise<boolean> {
  return withMcpStateMutation(async () => {
    const current = (await readMcpConfig()).servers[name];
    if (mcpServerAuthIdentity(current) !== expectedIdentity) return false;
    await saveOAuthToken(name, { ...token, serverIdentity: expectedIdentity });
    return true;
  });
}

/** The reserved stem-recall entry the bridge always spawns. */
function recallServerEntry(): PiMcpServer {
  return {
    command: host().nodeSpawn().command,
    args: [recallMcpServerPath()],
    env: {
      ...host().nodeSpawn().env,
      STEM_RECALL_DB: recallDbPath(),
      // Query-embed channel for hybrid search (embed-endpoint.ts). The token is a
      // lazy singleton, so reading it here at bootstrap is safe even before (or
      // without) the endpoint actually listening — the server falls back to
      // keyword-only whenever the socket doesn't answer.
      STEM_EMBED_SOCK: embedSocketPath(),
      STEM_EMBED_TOKEN: getEmbedEndpointToken(),
      // Indexed connected folders: the server re-reads manifest.json in this dir
      // on every search_folder_docs call, so new indexes need no pi restart.
      STEM_FOLDER_INDEX_DIR: folderIndexDir()
    },
    trusted: true
  };
}

/**
 * Field-level secrets in mcp.json: header values (bearer tokens), stdio env
 * values (API keys, the embed-endpoint token), and the static OAuth client
 * secret are encrypted on write and decrypted on read, so the parsed config in
 * memory is always plaintext — mcpServerAuthIdentity therefore hashes the same
 * bytes it always has, keeping existing token identity stamps valid. A value
 * that no longer decrypts is dropped (the server re-auths) rather than sent
 * upstream as ciphertext.
 */
function encryptServerSecrets(server: PiMcpServer): PiMcpServer {
  const out = { ...server };
  if (out.headers) {
    out.headers = Object.fromEntries(Object.entries(out.headers).map(([k, v]) => [k, encryptSecretValue(v)]));
  }
  if (out.env) {
    out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, encryptSecretValue(v)]));
  }
  if (out.oauthClientSecret) out.oauthClientSecret = encryptSecretValue(out.oauthClientSecret);
  return out;
}

function decryptRecord(record: Record<string, string>): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(record)) {
    const plain = decryptSecretValue(v);
    if (plain !== null) entries.push([k, plain]);
  }
  return Object.fromEntries(entries);
}

function decryptServerSecrets(server: PiMcpServer): PiMcpServer {
  const out = { ...server };
  if (out.headers) out.headers = decryptRecord(out.headers);
  if (out.env) out.env = decryptRecord(out.env);
  if (out.oauthClientSecret) {
    const plain = decryptSecretValue(out.oauthClientSecret);
    if (plain === null) delete out.oauthClientSecret;
    else out.oauthClientSecret = plain;
  }
  return out;
}

/**
 * Read mcp.json, distinguishing a genuinely missing file (legitimate first run →
 * fresh config) from one that exists but is corrupt/unparseable. The corrupt case
 * MUST NOT be silently treated as empty: callers that read-modify-write (notably
 * {@link ensureMcpConfig}) would then persist that emptiness and wipe every
 * user-added server. Instead we preserve the bytes to a `.corrupt` sibling for
 * recovery and throw, so the loss is visible and recoverable rather than silent.
 */
export async function readMcpConfig(): Promise<PiMcpConfig> {
  let raw: string;
  try {
    raw = await readFile(piMcpConfigPath(), 'utf8');
  } catch {
    return { servers: {} }; // genuinely missing → fresh
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PiMcpConfig>;
    if (parsed && typeof parsed === 'object' && parsed.servers) {
      return {
        servers: Object.fromEntries(
          Object.entries(parsed.servers).map(([name, server]) => [name, decryptServerSecrets(server)])
        )
      };
    }
    throw new Error('mcp.json has no "servers" object');
  } catch (e) {
    await writeFile(`${piMcpConfigPath()}.corrupt`, raw, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
    throw new Error(`mcp.json is corrupt (preserved at ${piMcpConfigPath()}.corrupt): ${String(e)}`);
  }
}

export async function writeMcpConfig(config: PiMcpConfig): Promise<void> {
  // mcp.json can carry remote-server auth headers (e.g. `Authorization: Bearer …`)
  // and stdio env tokens; those fields go to disk encrypted (see above).
  const servers = Object.fromEntries(
    Object.entries(config.servers).map(([name, server]) => [name, encryptServerSecrets(server)])
  );
  await writeSecretFile(piMcpConfigPath(), JSON.stringify({ servers }, null, 2));
}

/**
 * Ensure mcp.json exists with a fresh stem-recall entry (paths can change between
 * runs), preserving any user-added servers. Idempotent; called at bootstrap.
 */
export async function ensureMcpConfig(): Promise<void> {
  await withMcpStateMutation(async () => {
    let config: PiMcpConfig;
    try {
      config = await readMcpConfig();
    } catch {
      // Corrupt mcp.json (already preserved as `.corrupt` by readMcpConfig). Start
      // fresh so recall and the app keep working; the backup keeps any recoverable
      // user servers around instead of erasing them without a trace.
      config = { servers: {} };
    }
    config.servers[RECALL_MCP_NAME] = recallServerEntry();
    await writeMcpConfig(config);
  });
}
