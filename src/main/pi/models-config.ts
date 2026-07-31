import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LocalProviderTestResult } from '../../shared/types';
import { LOCAL_PROVIDER_IDS, isLocalProviderId } from '../../shared/providers';
import { piModelsConfigPath } from '../workspace/paths';
import { readSettings } from '../workspace/settings';

// Stem's custom-providers config for the pi backend (models.json under the
// isolated pi home). OpenAI-compatible servers (Ollama, LM Studio, and a custom
// endpoint) are registered here; pi's model registry reads the file at spawn.
// NOTE: pi's RPC mode never re-reads models.json mid-process (only the TUI's
// /model command refreshes the registry), so every content change must be
// followed by a runtime restart — callers use syncModelsConfig()'s return value
// to decide.

/** Model entry pi accepts in models.json (only `id` is required). */
interface PiModelConfig {
  id: string;
  [key: string]: unknown;
}

interface PiProviderConfig {
  baseUrl: string;
  api: string;
  apiKey?: string;
  compat?: Record<string, unknown>;
  models?: PiModelConfig[];
  [key: string]: unknown;
}

interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>;
}

/** Probe timeout: local servers answer in ms; anything slower is effectively down. */
const PROBE_TIMEOUT_MS = 2_500;

/**
 * Normalize a user-entered server URL to the server root: no trailing slash, no
 * trailing /v1 (users paste both forms; Stem appends /v1/… itself).
 */
export function normalizeLocalBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  url = url.replace(/\/v1$/i, '');
  return url;
}

/**
 * Ollama rejects tool-bearing requests outright (HTTP 400) for models without
 * tool support — and Stem's turns always carry tools, so such a model can never
 * complete a turn. Ollama reports per-model capabilities via POST /api/show;
 * keep only models listing "tools". Non-Ollama servers (LM Studio, vLLM, …)
 * don't have that endpoint — the check fails and every model is kept.
 */
async function isToolCapable(base: string, id: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      body: JSON.stringify({ model: id }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (!res.ok) return true; // not Ollama → no capability info → keep
    const body = (await res.json()) as { capabilities?: unknown };
    return !Array.isArray(body.capabilities) || body.capabilities.includes('tools');
  } catch {
    return true; // can't tell → keep
  }
}

/**
 * Ask an OpenAI-compatible server which models it serves (GET /v1/models),
 * dropping models that can't call tools (see isToolCapable). `apiKey` is sent as
 * a bearer token for endpoints that require one. Never throws — failures come
 * back as { ok:false, error } for the Test UI.
 */
export async function probeLocalProvider(baseUrl: string, apiKey?: string): Promise<LocalProviderTestResult> {
  const base = normalizeLocalBaseUrl(baseUrl);
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Enter a URL like http://localhost:11434.' };
  const key = apiKey?.trim();
  try {
    const res = await fetch(`${base}/v1/models`, {
      ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (!res.ok) return { ok: false, error: `The server answered ${res.status} ${res.statusText}.` };
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const all = (body.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id.trim() : ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    // Ollama is keyless, so a bearer token means this isn't Ollama — skip the
    // per-model capability round-trips instead of spraying /api/show at a
    // third-party endpoint that will only 404 them.
    const capable = key ? all.map(() => true) : await Promise.all(all.map((id) => isToolCapable(base, id)));
    const models = all.filter((_, i) => capable[i]);
    const skipped = all.length - models.length;
    return { ok: true, models, ...(skipped > 0 ? { skippedNoTools: skipped } : {}) };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'The server did not answer in time.' : e.message) : String(e);
    return { ok: false, error: msg };
  }
}

/** The provider block written for an enabled local server. */
function localProviderBlock(baseUrl: string, models: PiModelConfig[], apiKey?: string): PiProviderConfig {
  return {
    baseUrl: `${normalizeLocalBaseUrl(baseUrl)}/v1`,
    api: 'openai-completions',
    // Keyless servers still need a non-empty key for pi to consider the models
    // available (pi's own docs recommend a dummy value).
    apiKey: apiKey?.trim() || 'local',
    // Local OpenAI-compatible servers generally don't understand the `developer`
    // role or `reasoning_effort` — pi's documented defaults for Ollama & co.
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models
  };
}

/**
 * Read models.json, tolerating a missing file (fresh install) and quarantining a
 * corrupt one (preserved as `.corrupt`, like mcp-config) so hand-edits are never
 * silently destroyed.
 */
export async function readModelsConfig(): Promise<PiModelsConfig> {
  const path = piModelsConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { providers: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PiModelsConfig>;
    if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
      return { providers: parsed.providers };
    }
    return { providers: {} };
  } catch {
    // Uniquified like the write below: two readers hitting the same corrupt file
    // must not overwrite each other's quarantine copy mid-write.
    await writeFile(`${path}.${process.pid}.${randomUUID()}.corrupt`, raw, 'utf8').catch(() => undefined);
    return { providers: {} };
  }
}

/**
 * Write via a temp file named per-writer, not per-path. A shared `<path>.tmp` is
 * only atomic for a single writer: two concurrent syncs would share one inode, so
 * one could rename it out from under the other's half-finished write and leave a
 * truncated models.json — which readModelsConfig then quarantines, silently
 * dropping every local provider. The `finally` clears the temp on a failed rename
 * so a crash can't accumulate them.
 */
async function writeModelsConfig(config: PiModelsConfig): Promise<void> {
  const path = piModelsConfigPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await rename(tmp, path); // atomic in the same dir
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Whether pi will still recognize `provider` when a spawn names it. Only the
 * providers Stem registers itself can go missing — they exist for pi purely as
 * models.json blocks, and a disconnect (or a server that was unreachable when
 * the catalog was last synced) removes them. pi's built-in providers are always
 * part of its registry, so everything else answers true.
 *
 * Callers use this before handing pi `--provider`: an unknown one is fatal at
 * startup, not merely unusable.
 *
 * Reads the file directly rather than through readModelsConfig(): this is a
 * query on a hot path (every listModels), and quarantining a corrupt file per
 * call would litter. Unreadable/unparseable answers false, which is also what
 * pi sees — it drops the whole config when it doesn't parse or validate.
 */
export async function providerIsSpawnable(provider: string): Promise<boolean> {
  if (!isLocalProviderId(provider)) return true;
  try {
    const parsed = JSON.parse(await readFile(piModelsConfigPath(), 'utf8')) as Partial<PiModelsConfig>;
    return !!parsed?.providers?.[provider]?.models?.length;
  } catch {
    return false;
  }
}

// Serialize syncs through a promise chain (see workspace/settings.ts) so two of
// them can't interleave their read-modify-write of models.json. The critical
// section spans the probes, which take seconds — the window this closes is wide.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}


/**
 * Bring models.json in line with the local-provider settings: probe each enabled
 * server for its models and (re)write its provider block; drop blocks for
 * disabled providers; leave any hand-added third-party providers untouched.
 *
 * When a probe fails (server temporarily down), the provider's last-known models
 * are kept so a stopped server doesn't wipe the catalog.
 *
 * Serialized, and it takes no settings argument on purpose: the settings read
 * happens inside the critical section, immediately before the write. A caller
 * that read settings first and handed them over could have that snapshot commit
 * *after* a disconnect that landed while it was probing — restoring the provider
 * block and the API key the user had just removed. Enqueue order is not snapshot
 * order, so serializing alone would not have fixed that.
 *
 * Returns true when the file content actually changed — the caller must then
 * restart the pi process for the registry to pick it up.
 */
export function syncModelsConfig(): Promise<boolean> {
  return enqueue(async () => {
    const settings = (await readSettings()).localProviders;
    const config = await readModelsConfig();
    const before = JSON.stringify(config);

    for (const id of LOCAL_PROVIDER_IDS) {
      const { enabled, baseUrl, apiKey, models: manual } = settings[id];
      if (!enabled) {
        delete config.providers[id];
        continue;
      }
      // Hand-entered ids are authoritative: an endpoint that names its models has
      // opted out of discovery, so don't probe it (and don't let a listing endpoint
      // it happens to serve override the user's choice).
      if (manual?.length) {
        config.providers[id] = localProviderBlock(baseUrl, manual.map((m) => ({ id: m })), apiKey);
        continue;
      }
      const probe = await probeLocalProvider(baseUrl, apiKey);
      const lastKnown = config.providers[id]?.models ?? [];
      const models = probe.ok ? probe.models!.map((m) => ({ id: m })) : lastKnown;
      // A block with no models is worse than no block: pi builds its provider
      // list from the models it can see, so an empty one leaves the provider
      // *unknown* — and a spawn asking for it (`--provider ollama`) then dies
      // with "Unknown provider", taking every other provider down with it.
      // Nothing is lost by waiting: the next sync writes it once a probe answers.
      if (models.length) config.providers[id] = localProviderBlock(baseUrl, models, apiKey);
      else delete config.providers[id];
    }

    const changed = JSON.stringify(config) !== before;
    if (changed) await writeModelsConfig(config);
    return changed;
  });
}
