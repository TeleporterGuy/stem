import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LocalProviderTestResult, LocalProvidersSettings } from '../../shared/types';
import { LOCAL_PROVIDER_IDS } from '../../shared/providers';
import { piModelsConfigPath } from '../workspace/paths';
import { readSettings } from '../workspace/settings';

// Stem's custom-providers config for the pi backend (models.json under the
// isolated pi home). Local OpenAI-compatible servers (Ollama, LM Studio) are
// registered here; pi's model registry reads the file when the process spawns.
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
 * Ask a local OpenAI-compatible server which models it serves (GET /v1/models),
 * dropping models that can't call tools (see isToolCapable). Never throws —
 * failures come back as { ok:false, error } for the Test UI.
 */
export async function probeLocalProvider(baseUrl: string): Promise<LocalProviderTestResult> {
  const base = normalizeLocalBaseUrl(baseUrl);
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Enter a URL like http://localhost:11434.' };
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `The server answered ${res.status} ${res.statusText}.` };
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const all = (body.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id.trim() : ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const capable = await Promise.all(all.map((id) => isToolCapable(base, id)));
    const models = all.filter((_, i) => capable[i]);
    const skipped = all.length - models.length;
    return { ok: true, models, ...(skipped > 0 ? { skippedNoTools: skipped } : {}) };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'The server did not answer in time.' : e.message) : String(e);
    return { ok: false, error: msg };
  }
}

/** The provider block written for an enabled local server. */
function localProviderBlock(baseUrl: string, models: PiModelConfig[]): PiProviderConfig {
  return {
    baseUrl: `${normalizeLocalBaseUrl(baseUrl)}/v1`,
    api: 'openai-completions',
    // Keyless servers still need a non-empty key for pi to consider the models
    // available (pi's own docs recommend a dummy value).
    apiKey: 'local',
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
    await writeFile(`${path}.corrupt`, raw, 'utf8').catch(() => undefined);
    return { providers: {} };
  }
}

async function writeModelsConfig(config: PiModelsConfig): Promise<void> {
  const path = piModelsConfigPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await rename(tmp, path); // atomic in the same dir
}


/**
 * Bring models.json in line with the local-provider settings: probe each enabled
 * server for its models and (re)write its provider block; drop blocks for
 * disabled providers; leave any hand-added third-party providers untouched.
 *
 * When a probe fails (server temporarily down), the provider's last-known models
 * are kept so a stopped server doesn't wipe the catalog.
 *
 * Returns true when the file content actually changed — the caller must then
 * restart the pi process for the registry to pick it up.
 */
export async function syncModelsConfig(localProviders?: LocalProvidersSettings): Promise<boolean> {
  const settings = localProviders ?? (await readSettings()).localProviders;
  const config = await readModelsConfig();
  const before = JSON.stringify(config);

  for (const id of LOCAL_PROVIDER_IDS) {
    const { enabled, baseUrl } = settings[id];
    if (!enabled) {
      delete config.providers[id];
      continue;
    }
    const probe = await probeLocalProvider(baseUrl);
    const lastKnown = config.providers[id]?.models ?? [];
    const models = probe.ok ? probe.models!.map((m) => ({ id: m })) : lastKnown;
    config.providers[id] = localProviderBlock(baseUrl, models);
  }

  const changed = JSON.stringify(config) !== before;
  if (changed) await writeModelsConfig(config);
  return changed;
}
