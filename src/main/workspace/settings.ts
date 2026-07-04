import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type {
  AppSettings,
  CustomInstructionsSettings,
  DefaultsSettings,
  EmbeddingsMode,
  EmbeddingsSettings,
  EscapeAction,
  OnboardingSettings,
  LocalEmbedModelId,
  LocalProviderId,
  LocalProviderSettings,
  LocalProvidersSettings,
  LocalRerankModelId,
  MemoryModelSettings,
  NativeWebSearchSettings,
  PartialRetrievalSettings,
  QuickChatSettings,
  RerankerMode,
  RerankerSettings,
  RetrievalSettings,
  SkillsModelSettings
} from '../../shared/types';
import { settingsStorePath } from './paths';

// Stem-owned app settings. Like the chat store, kept deliberately tiny and
// resilient — a corrupt/missing file degrades to defaults rather than breaking
// startup. The defaults match the product spec: medium effort, Fast speed, and
// the overlay floating across all displays; the shortcut is unset until the
// user records one in Settings.

const DEFAULTS: AppSettings = {
  quickChat: {
    shortcut: null,
    defaultModel: null,
    defaultEffort: 'medium',
    defaultServiceTier: 'priority',
    showOnAllDisplays: true,
    // After 5 minutes idle, re-summoning the overlay starts a fresh thread.
    newThreadTimeoutMs: 5 * 60_000,
    // Show the progress pill for main-window threads when the main window loses
    // focus (switch Spaces/apps), so an active thread stays visible.
    followAcrossSpaces: true,
    // Opt-in chime when a turn finishes while the pill is visible.
    finishSound: false
  },
  // Native web search defaults on for both contexts; surfaced in the UI only when
  // the relevant model's provider supports it (currently ChatGPT/openai-codex).
  nativeWebSearch: { main: true, quickChat: true },
  // Memory distillation/tidy-up model; null = the backend default.
  memory: { model: null },
  // Background skills-curator model; null = the backend default. Separate from the
  // memory model so curation (which can be a harder task) can use a stronger model.
  skills: { model: null },
  // Embeddings + reranker for relevance-ranking facts at inject time. Embeddings
  // default to the bundled local model (multilingual, in-process, nothing leaves
  // the machine); weights download once on first need, and until they're ready
  // fact selection stays lexical/recency-based. Remote URL/model defaults match
  // a local Ollama setup for users who switch to their own endpoint.
  retrieval: {
    embeddings: {
      mode: 'local',
      localModel: 'multilingual-e5-small',
      baseUrl: 'http://localhost:11434',
      // 4b, not 8b: measured best cross-language fact recall on Ollama (2026-07-04).
      model: 'qwen3-embedding:4b',
      apiKey: null
    },
    reranker: {
      mode: 'off',
      localModel: 'bge-reranker-v2-m3',
      baseUrl: 'http://localhost:8080',
      model: '',
      apiKey: null
    }
  },
  // Escape-to-retract is opt-in: off until the user picks single/two-stage.
  escapeAction: 'off',
  // Standing custom instructions; empty until the user (or Stem) sets them.
  customInstructions: { main: '', quickChat: '' },
  // First-run wizard: not completed until the user signs in (or the app first
  // reaches an authenticated status, e.g. seeded from an existing ~/.pi).
  onboarding: { completed: false },
  // App-level default model ('provider/modelId'); null = built-in constant.
  // Set after onboarding to match the provider the user signed in with.
  defaults: { model: null },
  // Local model servers (registered with the backend via the pi-home models.json).
  // Base URLs are the servers' standard defaults; disabled until the user opts in.
  localProviders: {
    ollama: { enabled: false, baseUrl: 'http://localhost:11434' },
    lmstudio: { enabled: false, baseUrl: 'http://localhost:1234' }
  }
};

const ESCAPE_ACTIONS: readonly EscapeAction[] = ['off', 'single', 'twoStage'];

const RERANKER_MODES: readonly RerankerMode[] = ['off', 'local', 'remote'];
const LOCAL_RERANK_MODELS: readonly LocalRerankModelId[] = ['bge-reranker-v2-m3'];

function coerceReranker(
  raw: (Partial<RerankerSettings> & { enabled?: unknown }) | undefined,
  def: RerankerSettings
): RerankerSettings {
  const r = raw ?? {};
  // Migration from the pre-mode shape ({ enabled: boolean } + endpoint fields):
  // enabled:true meant "user pointed us at their own /rerank server" → remote;
  // anything else takes the default (off — the rerank stage is opt-in).
  const mode: RerankerMode = RERANKER_MODES.includes(r.mode as RerankerMode)
    ? (r.mode as RerankerMode)
    : r.enabled === true
      ? 'remote'
      : def.mode;
  return {
    mode,
    localModel: LOCAL_RERANK_MODELS.includes(r.localModel as LocalRerankModelId)
      ? (r.localModel as LocalRerankModelId)
      : def.localModel,
    baseUrl: typeof r.baseUrl === 'string' && r.baseUrl.trim() ? r.baseUrl.trim() : def.baseUrl,
    model: typeof r.model === 'string' ? r.model.trim() : def.model,
    apiKey: typeof r.apiKey === 'string' && r.apiKey.trim() ? r.apiKey : null
  };
}

const EMBEDDINGS_MODES: readonly EmbeddingsMode[] = ['off', 'local', 'remote'];
const LOCAL_EMBED_MODELS: readonly LocalEmbedModelId[] = [
  'multilingual-e5-small',
  'multilingual-e5-base',
  'embeddinggemma-300m'
];

function coerceEmbeddings(
  raw: (Partial<EmbeddingsSettings> & { enabled?: unknown }) | undefined,
  def: EmbeddingsSettings
): EmbeddingsSettings {
  const r = raw ?? {};
  // Migration from the pre-mode shape ({ enabled: boolean } + endpoint fields):
  // enabled:true meant "user pointed us at their own server" → remote. enabled:false
  // is indistinguishable from "never touched" (defaults persist to settings.json),
  // so it takes the new local default; an explicit Off mode remains available.
  const mode: EmbeddingsMode = EMBEDDINGS_MODES.includes(r.mode as EmbeddingsMode)
    ? (r.mode as EmbeddingsMode)
    : r.enabled === true
      ? 'remote'
      : def.mode;
  return {
    mode,
    localModel: LOCAL_EMBED_MODELS.includes(r.localModel as LocalEmbedModelId)
      ? (r.localModel as LocalEmbedModelId)
      : def.localModel,
    baseUrl: typeof r.baseUrl === 'string' && r.baseUrl.trim() ? r.baseUrl.trim() : def.baseUrl,
    model: typeof r.model === 'string' ? r.model.trim() : def.model,
    apiKey: typeof r.apiKey === 'string' && r.apiKey.trim() ? r.apiKey : null
  };
}

function coerce(parsed: Partial<AppSettings> | null): AppSettings {
  const qc = (parsed?.quickChat ?? {}) as Partial<QuickChatSettings>;
  const d = DEFAULTS.quickChat;
  const rawNws = (parsed?.nativeWebSearch ?? {}) as Partial<NativeWebSearchSettings>;
  const nws: NativeWebSearchSettings = {
    main: typeof rawNws.main === 'boolean' ? rawNws.main : DEFAULTS.nativeWebSearch.main,
    quickChat: typeof rawNws.quickChat === 'boolean' ? rawNws.quickChat : DEFAULTS.nativeWebSearch.quickChat
  };
  const rawMem = (parsed?.memory ?? {}) as Partial<MemoryModelSettings>;
  const mem: MemoryModelSettings = {
    model: typeof rawMem.model === 'string' && rawMem.model.trim() ? rawMem.model : null
  };
  const rawSkills = (parsed?.skills ?? {}) as Partial<SkillsModelSettings>;
  const skills: SkillsModelSettings = {
    model: typeof rawSkills.model === 'string' && rawSkills.model.trim() ? rawSkills.model : null
  };
  const rawRet = (parsed?.retrieval ?? {}) as Partial<RetrievalSettings>;
  const retrieval: RetrievalSettings = {
    embeddings: coerceEmbeddings(rawRet.embeddings, DEFAULTS.retrieval.embeddings),
    reranker: coerceReranker(rawRet.reranker, DEFAULTS.retrieval.reranker)
  };
  const escapeAction: EscapeAction = ESCAPE_ACTIONS.includes(parsed?.escapeAction as EscapeAction)
    ? (parsed!.escapeAction as EscapeAction)
    : DEFAULTS.escapeAction;
  const rawCi = (parsed?.customInstructions ?? {}) as Partial<CustomInstructionsSettings>;
  const customInstructions: CustomInstructionsSettings = {
    main: typeof rawCi.main === 'string' ? rawCi.main : DEFAULTS.customInstructions.main,
    quickChat: typeof rawCi.quickChat === 'string' ? rawCi.quickChat : DEFAULTS.customInstructions.quickChat
  };
  const rawOb = (parsed?.onboarding ?? {}) as Partial<OnboardingSettings>;
  const onboarding: OnboardingSettings = {
    completed: typeof rawOb.completed === 'boolean' ? rawOb.completed : DEFAULTS.onboarding.completed
  };
  const rawDef = (parsed?.defaults ?? {}) as Partial<DefaultsSettings>;
  const defaults: DefaultsSettings = {
    model: typeof rawDef.model === 'string' && rawDef.model.trim() ? rawDef.model : null
  };
  const rawLp = (parsed?.localProviders ?? {}) as Partial<Record<LocalProviderId, Partial<LocalProviderSettings>>>;
  const coerceLocal = (id: LocalProviderId): LocalProviderSettings => {
    const r = rawLp[id] ?? {};
    const def = DEFAULTS.localProviders[id];
    return {
      enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled,
      baseUrl: typeof r.baseUrl === 'string' && r.baseUrl.trim() ? r.baseUrl.trim() : def.baseUrl
    };
  };
  const localProviders: LocalProvidersSettings = {
    ollama: coerceLocal('ollama'),
    lmstudio: coerceLocal('lmstudio')
  };
  return {
    quickChat: {
      shortcut: typeof qc.shortcut === 'string' && qc.shortcut.trim() ? qc.shortcut : null,
      defaultModel: typeof qc.defaultModel === 'string' && qc.defaultModel.trim() ? qc.defaultModel : null,
      defaultEffort: typeof qc.defaultEffort === 'string' ? qc.defaultEffort : d.defaultEffort,
      // 'priority' (Fast) or explicit null (Standard); anything else → default.
      defaultServiceTier:
        qc.defaultServiceTier === 'priority' ? 'priority' : qc.defaultServiceTier === null ? null : d.defaultServiceTier,
      showOnAllDisplays: typeof qc.showOnAllDisplays === 'boolean' ? qc.showOnAllDisplays : d.showOnAllDisplays,
      newThreadTimeoutMs:
        typeof qc.newThreadTimeoutMs === 'number' && qc.newThreadTimeoutMs >= 0
          ? qc.newThreadTimeoutMs
          : d.newThreadTimeoutMs,
      followAcrossSpaces: typeof qc.followAcrossSpaces === 'boolean' ? qc.followAcrossSpaces : d.followAcrossSpaces,
      finishSound: typeof qc.finishSound === 'boolean' ? qc.finishSound : d.finishSound
    },
    nativeWebSearch: nws,
    memory: mem,
    skills,
    retrieval,
    escapeAction,
    customInstructions,
    onboarding,
    defaults,
    localProviders
  };
}

export async function readSettings(): Promise<AppSettings> {
  try {
    return coerce(JSON.parse(await readFile(settingsStorePath(), 'utf8')) as Partial<AppSettings>);
  } catch {
    return coerce(null);
  }
}

// Serialize writes through a promise chain (see chats.ts) so concurrent IPC
// can't interleave a read-modify-write and lose updates.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeSettings(settings: AppSettings): Promise<void> {
  const path = settingsStorePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
  await rename(tmp, path);
}

/** Patch the Quick Chat settings and persist atomically; returns the full settings. */
export function updateQuickChat(patch: Partial<QuickChatSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, quickChat: { ...cur.quickChat, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the per-context native-web-search toggles and persist; returns full settings. */
export function updateNativeWebSearch(patch: Partial<NativeWebSearchSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, nativeWebSearch: { ...cur.nativeWebSearch, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Set the main-composer Escape-to-retract behavior and persist; returns full settings. */
export function updateEscapeAction(action: EscapeAction): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, escapeAction: action });
    await writeSettings(next);
    return next;
  });
}

/** Patch the memory-model setting and persist; returns the full settings. */
export function updateMemorySettings(patch: Partial<MemoryModelSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, memory: { ...cur.memory, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the standing custom instructions (per surface) and persist; returns full settings. */
export function updateCustomInstructions(patch: Partial<CustomInstructionsSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, customInstructions: { ...cur.customInstructions, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the skills-curator model setting and persist; returns the full settings. */
export function updateSkillsSettings(patch: Partial<SkillsModelSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, skills: { ...cur.skills, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Mark the first-run wizard finished and persist; returns the full settings. */
export function markOnboardingCompleted(): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, onboarding: { completed: true } });
    await writeSettings(next);
    return next;
  });
}

/** Set the app-level default model ('provider/modelId' or null) and persist. */
export function updateDefaultModel(model: string | null): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, defaults: { model } });
    await writeSettings(next);
    return next;
  });
}

/** Patch one local provider (Ollama / LM Studio) and persist; returns the full settings. */
export function updateLocalProvider(id: LocalProviderId, patch: Partial<LocalProviderSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({
      ...cur,
      localProviders: { ...cur.localProviders, [id]: { ...cur.localProviders[id], ...patch } }
    });
    await writeSettings(next);
    return next;
  });
}

/** Patch the retrieval endpoints (deep-merged per stage) and persist; returns full settings. */
export function updateRetrievalSettings(patch: PartialRetrievalSettings): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({
      ...cur,
      retrieval: {
        embeddings: { ...cur.retrieval.embeddings, ...patch.embeddings },
        reranker: { ...cur.retrieval.reranker, ...patch.reranker }
      }
    });
    await writeSettings(next);
    return next;
  });
}
