import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Brain, Plug, Globe, HardDrive, Plus, Minus, ChevronRight, MessageSquare, Settings, X, Check, FolderOpen, FolderTree, Trash2, Wand2, CalendarClock, Play, Pause, ExternalLink, Eye, RefreshCw } from 'lucide-react';
import type {
  AuthProviderId,
  ApiKeyProviderId,
  BackendEventEnvelope,
  McpLoginUrlParams,
  McpServerStatus,
  McpServerSummary,
  McpTransport,
  EmbeddingCacheStats,
  EpisodicStats,
  MemoryContents,
  MemorySettings,
  ConnectedFolder,
  CustomInstructionsSettings,
  EscapeAction,
  ScheduledTask,
  ModelSummary,
  NativeWebSearchSettings,
  QuickChatSettings,
  EmbeddingsMode,
  EmbeddingsSettings,
  LocalEmbedModelId,
  LocalEmbedStatus,
  LocalProviderId,
  LocalProvidersSettings,
  LocalProviderTestResult,
  LocalRerankModelId,
  LocalRerankStatus,
  RerankerMode,
  RerankerSettings,
  RetrievalSettings,
  RetrievalTestResult,
  SkillSummary,
  ActiveFacts,
  FactTier
} from '../../shared/types';
import { API_KEY_PROVIDER_IDS, isLocalProviderId, providerName } from '../../shared/providers';
import { MdxView } from '../chat/MdxView';
import { ChatList, type ChatListProps } from '../chats/ChatList';
import { ModelPicker } from '../ui/ModelPicker';
import { EFFORT_LABELS } from '../modelLabels';

type Tab = 'chats' | 'memory' | 'mcp' | 'folders' | 'tasks' | 'settings';

const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'mcp', label: 'MCP & Skills', icon: Plug },
  { id: 'folders', label: 'Folders', icon: FolderTree },
  { id: 'tasks', label: 'Tasks', icon: CalendarClock },
  { id: 'settings', label: 'Settings', icon: Settings }
];

// Inactivity presets for starting a fresh Quick Chat thread on re-summon.
// 0 = never (always continue the current session).
const NEW_THREAD_PRESETS: { label: string; ms: number }[] = [
  { label: 'Off', ms: 0 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 5 * 60_000 },
  { label: '15m', ms: 15 * 60_000 }
];

// Auto tidy-up cadence, expressed as the new-fact count that triggers a pass
// (0 = manual only). Mirrors CONSOLIDATE defaults in the recall store.
const TIDY_PRESETS: { label: string; value: number; hint: string }[] = [
  { label: 'Frequent', value: 3, hint: 'after 3 new facts' },
  { label: 'Normal', value: 5, hint: 'after 5 new facts' },
  { label: 'Occasional', value: 10, hint: 'after 10 new facts' },
  { label: 'Manual', value: 0, hint: 'never automatically' }
];

// Inject-all-facts ceiling: at or below this many stored facts every fact rides
// along on each message; above it, only the most relevant are selected. Default
// is 200 (see DEFAULT_FACT_THRESHOLD in the recall store).
const FACT_INJECT_PRESETS: { label: string; value: number }[] = [
  { label: '40', value: 40 },
  { label: '200', value: 200 },
  { label: '500', value: 500 },
  { label: '1000', value: 1000 }
];

// Episodic-store size caps. 0 = unlimited. Default is 100 MB (see the recall store).
const MB = 1024 * 1024;
const EPISODIC_PRESETS: { label: string; bytes: number }[] = [
  { label: '50 MB', bytes: 50 * MB },
  { label: '100 MB', bytes: 100 * MB },
  { label: '250 MB', bytes: 250 * MB },
  { label: 'Unlimited', bytes: 0 }
];

// Icon-button feedback: a fast local call finishes before the spin animation shows
// a single visible frame, which reads as "nothing happened". Hold the spinning
// state until the animation lands on a whole rotation (cycle length must match
// link-btn-spin in styles.css), so short jobs show one clean turn and longer jobs
// stop without a mid-rotation snap.
const SPIN_CYCLE_MS = 900;
async function holdFullSpin<T>(work: Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await work;
  } finally {
    const elapsed = Date.now() - start;
    await new Promise((r) => setTimeout(r, SPIN_CYCLE_MS - (elapsed % SPIN_CYCLE_MS)));
  }
}

interface ModelTabProps {
  models: ModelSummary[];
  modelId: string | null;
  onSelectModel: (id: string) => void;
}

// Active-facts debug surface, fed from App. Lets the Memory→Facts tab show which
// durable facts this chat injected last turn (and preview the current draft).
interface ActiveFactsViewProps {
  /** The open chat, or null for a fresh draft (no last-turn set yet). */
  activeThreadId: string | null;
  /** Active chat's running flag — flips drive a refetch of the last injected set. */
  activeRunning: boolean;
  /** Whether draft preview is toggled on (owned by App so it resets on send). */
  previewActive: boolean;
  /** Live draft text, mirrored from the composer while preview is on. */
  previewDraft: string;
  onTogglePreview: () => void;
}

export type ManagePanelProps = ChatListProps & ModelTabProps & ActiveFactsViewProps;

export function ManagePanel({
  models,
  modelId,
  onSelectModel,
  activeThreadId,
  activeRunning,
  previewActive,
  previewDraft,
  onTogglePreview,
  ...chatProps
}: ManagePanelProps) {
  const activeFacts: ActiveFactsViewProps = {
    activeThreadId,
    activeRunning,
    previewActive,
    previewDraft,
    onTogglePreview
  };
  const [tab, setTab] = useState<Tab>('chats');
  return (
    <div className="manage">
      <div className="insp-tabs">
        <div className="insp-seg">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              title={label}
              aria-label={label}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
      </div>
      <div className={`manage-body${tab === 'chats' ? ' chats' : ''}`}>
        {tab === 'chats' && <ChatList {...chatProps} activeThreadId={activeThreadId} />}
        {tab === 'memory' && <MemoryTab models={models} activeFacts={activeFacts} />}
        {tab === 'mcp' && <McpSkillsTab models={models} />}
        {tab === 'folders' && <FoldersTab />}
        {tab === 'tasks' && <TasksTab onOpenChat={chatProps.onOpen} />}
        {tab === 'settings' && (
          <SettingsTab models={models} modelId={modelId} onSelectModel={onSelectModel} />
        )}
      </div>
    </div>
  );
}

// Memory lives under the Brain icon as two sub-tabs: durable facts (Level 1) and
// the episodic recall store (Level 2, shown as metadata only — it's searched, not
// browsed). Mirrors the MCP + Skills sub-tab pattern below.
function MemoryTab({ models, activeFacts }: { models: ModelSummary[]; activeFacts: ActiveFactsViewProps }) {
  const [sub, setSub] = useState<'facts' | 'recall'>('facts');
  return (
    <div>
      <div className="seg-ctl">
        <button className={sub === 'facts' ? 'active' : ''} onClick={() => setSub('facts')}>
          Facts
        </button>
        <button className={sub === 'recall' ? 'active' : ''} onClick={() => setSub('recall')}>
          Recall
        </button>
      </div>
      {sub === 'facts' ? <FactsTab models={models} activeFacts={activeFacts} /> : <EpisodicTab />}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

function EpisodicTab() {
  const [stats, setStats] = useState<EpisodicStats | null>(null);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  function load() {
    window.stem.getEpisodicStats().then(setStats);
  }
  useEffect(() => {
    window.stem.getMemorySettings().then(setSettings);
    load();
  }, []);

  function selectLimit(bytes: number) {
    window.stem.setEpisodicLimit(bytes).then((s) => {
      setSettings(s);
      // Lowering the cap can trigger pruning on the next capture; refresh the size.
      load();
    });
  }

  async function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    setResetMsg(null);
    try {
      setStats(await window.stem.resetEpisodicMemory());
      setResetMsg('Episodic recall cleared.');
    } catch {
      setResetMsg('Reset failed — try again.');
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  }

  return (
    <div>
      {settings && (
        <div className="formgroup">
          <div className="set-block">
            <span className="set-sub">Storage limit</span>
            <div className="seg-ctl">
              {EPISODIC_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={settings.episodicLimitBytes === p.bytes ? 'active' : ''}
                  onClick={() => selectLimit(p.bytes)}
                  title={p.bytes === 0 ? 'Never prune episodic recall' : `Keep episodic recall under ${p.label}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="muted">When the store grows past this, Stem drops the oldest messages first.</p>
          </div>
        </div>
      )}

      <div className="memory-view">
        <div className="memory-view-head">
          <strong>Episodic recall</strong>
          <span className="memory-view-actions">
            <button className="link-btn" onClick={load}>Refresh</button>
          </span>
        </div>
        <p className="muted">
          The searchable history of past chats Stem draws on to recall what you've
          discussed before. Stored as a local database, never browsed directly.
        </p>
        {resetMsg && <p className="muted">{resetMsg}</p>}
        {!stats && <p className="muted">Loading…</p>}
        {stats && stats.messageCount === 0 && (
          <p className="muted">No episodic memory captured yet — Stem builds this as you chat.</p>
        )}
        {stats && stats.messageCount > 0 && (
          <p className="statement">
            {stats.messageCount.toLocaleString()}{' '}
            {stats.messageCount === 1 ? 'message' : 'messages'} · {formatBytes(stats.sizeBytes)}
          </p>
        )}

        {stats && stats.messageCount > 0 && (
          <div className="memory-reset">
            {confirmReset ? (
              <span className="memory-reset-confirm">
                <span className="muted">
                  Erase all {stats.messageCount.toLocaleString()} captured{' '}
                  {stats.messageCount === 1 ? 'message' : 'messages'}? This can’t be undone.
                </span>
                <button className="link-btn danger" onClick={reset} disabled={resetting}>
                  {resetting ? 'Resetting…' : 'Erase recall'}
                </button>
                <button className="link-btn" onClick={() => setConfirmReset(false)} disabled={resetting}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="link-btn danger memory-reset-trigger"
                onClick={reset}
                title="Permanently erase episodic recall (keeps facts + your files)"
              >
                <Trash2 size={12} /> Reset recall
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The curated local models, mirrored from main/recall/embed-catalog.ts (labels +
// sizes only — the specs live in main; the id is the contract).
const LOCAL_EMBED_MODELS: { id: LocalEmbedModelId; label: string; detail: string }[] = [
  { id: 'multilingual-e5-small', label: 'Multilingual E5 Small', detail: '~120 MB · recommended' },
  { id: 'multilingual-e5-base', label: 'Multilingual E5 Base', detail: '~280 MB · higher quality' },
  { id: 'embeddinggemma-300m', label: 'EmbeddingGemma 300M', detail: '~330 MB · largest' }
];

const EMBED_MODES: { id: EmbeddingsMode; label: string; hint: string }[] = [
  { id: 'local', label: 'Built-in', hint: 'Bundled multilingual model, runs on this Mac' },
  { id: 'remote', label: 'Server', hint: 'Your own OpenAI-compatible endpoint (Ollama, LM Studio…)' },
  { id: 'off', label: 'Off', hint: 'Rank facts by keywords/recency only' }
];

// The curated local reranker, mirrored from main/recall/rerank-catalog.ts.
const LOCAL_RERANK_MODELS: { id: LocalRerankModelId; label: string; detail: string }[] = [
  { id: 'bge-reranker-v2-m3', label: 'BGE Reranker v2 M3', detail: '~570 MB · multilingual' }
];

const RERANK_MODES: { id: RerankerMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Rank facts by embedding similarity only' },
  { id: 'local', label: 'Built-in', hint: 'Bundled cross-encoder re-scores the top matches, runs on this Mac' },
  { id: 'remote', label: 'Server', hint: 'Your own /rerank endpoint (llama.cpp --reranking, vLLM, Infinity…)' }
];

/** One line describing where a local retrieval model (embedder/reranker) is right now. */
function localStatusLabel(
  status: { state: LocalEmbedStatus['state']; progressPct?: number; dim?: number; error?: string } | null
): string {
  switch (status?.state) {
    case 'downloading':
      return `Downloading model… ${status.progressPct ?? 0}%`;
    case 'loading':
      return 'Loading model…';
    case 'ready':
      return `Ready${status.dim ? ` · ${status.dim}-dim` : ''}`;
    case 'error':
      return `Error: ${status.error ?? 'model failed to load'}`;
    default:
      // 'idle' is transient in local mode (the startup kick lands ~1.5 s after
      // launch), and we can't tell cached-from-not-yet-downloaded from here — so
      // don't claim either.
      return 'Starting up… (first use downloads the model once)';
  }
}

// Embeddings-stage controls: an exclusive Built-in / Server / Off mode, the local
// model picker + live download/ready status, or the remote endpoint fields (free
// text — Stem just makes the HTTP call). Text edits stay local while typing and
// persist on blur; mode/model switches persist immediately.
function EmbeddingsFields({
  value,
  onPatch
}: {
  value: EmbeddingsSettings;
  onPatch: (patch: Partial<EmbeddingsSettings>) => void;
}) {
  const [local, setLocal] = useState(value);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<RetrievalTestResult | null>(null);
  const [status, setStatus] = useState<LocalEmbedStatus | null>(null);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    window.stem.getLocalEmbedStatus().then(setStatus);
    return window.stem.onLocalEmbedStatus(setStatus);
  }, []);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await window.stem.testRetrievalEndpoint('embeddings'));
    } catch {
      setTest({ ok: false, detail: 'request failed' });
    } finally {
      setTesting(false);
    }
  }

  const mode = value.mode;

  return (
    <div className="set-block fg-divider">
      <div className="group-row">
        <span className="row-main">
          <strong>Embeddings</strong>
          <em>{EMBED_MODES.find((m) => m.id === mode)?.hint}</em>
        </span>
      </div>
      <div className="seg-ctl">
        {EMBED_MODES.map((m) => (
          <button
            key={m.id}
            className={mode === m.id ? 'active' : ''}
            onClick={() => {
              setTest(null);
              onPatch({ mode: m.id });
            }}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === 'local' && (
        <>
          <select
            className="ifield"
            aria-label="Local embedding model"
            value={value.localModel}
            onChange={(e) => {
              setTest(null);
              onPatch({ localModel: e.target.value as LocalEmbedModelId });
            }}
          >
            {LOCAL_EMBED_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.detail})
              </option>
            ))}
          </select>
          <p className="muted">{localStatusLabel(status)}</p>
        </>
      )}
      {mode === 'remote' && (
        <>
          <input
            className="ifield"
            placeholder="http://localhost:11434"
            aria-label="Embeddings base URL"
            value={local.baseUrl}
            onChange={(e) => setLocal({ ...local, baseUrl: e.target.value })}
            onBlur={() => onPatch({ baseUrl: local.baseUrl })}
          />
          <input
            className="ifield"
            placeholder="qwen3-embedding:4b"
            aria-label="Embeddings model"
            value={local.model}
            onChange={(e) => setLocal({ ...local, model: e.target.value })}
            onBlur={() => onPatch({ model: local.model })}
          />
          <p className="muted">
            Recommended with Ollama: <code>qwen3-embedding:4b</code> — the best cross-language fact
            recall we measured.
          </p>
          <input
            className="ifield"
            type="password"
            placeholder="API key (optional)"
            aria-label="Embeddings API key"
            value={local.apiKey ?? ''}
            onChange={(e) => setLocal({ ...local, apiKey: e.target.value })}
            onBlur={() => onPatch({ apiKey: local.apiKey })}
          />
        </>
      )}
      {mode !== 'off' && (
        <div className="retrieval-test">
          <button
            className="retrieval-test-btn"
            onClick={runTest}
            disabled={testing}
            title={testing ? 'Testing…' : 'Test connection'}
            aria-label="Test connection"
          >
            <Plug size={14} />
            <span>{testing ? 'Testing…' : 'Test connection'}</span>
          </button>
          {!testing && test && (
            <span className={`retrieval-test-status ${test.ok ? 'ok' : 'err'}`} title={test.detail}>
              {test.ok ? <Check size={12} /> : <X size={12} />}
              {test.detail}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Reranker-stage controls, mirroring EmbeddingsFields: an exclusive Off /
// Built-in / Server mode, the local model + live download/ready status, or the
// remote endpoint fields. The reranker re-scores the embedding shortlist with a
// cross-encoder — the precision stage that catches cross-language matches
// cosine ranking misses.
function RerankerFields({
  value,
  onPatch
}: {
  value: RerankerSettings;
  onPatch: (patch: Partial<RerankerSettings>) => void;
}) {
  const [local, setLocal] = useState(value);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<RetrievalTestResult | null>(null);
  const [status, setStatus] = useState<LocalRerankStatus | null>(null);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    window.stem.getLocalRerankStatus().then(setStatus);
    return window.stem.onLocalRerankStatus(setStatus);
  }, []);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await window.stem.testRetrievalEndpoint('reranker'));
    } catch {
      setTest({ ok: false, detail: 'request failed' });
    } finally {
      setTesting(false);
    }
  }

  const mode = value.mode;

  return (
    <div className="set-block fg-divider">
      <div className="group-row">
        <span className="row-main">
          <strong>Reranker</strong>
          <em>{RERANK_MODES.find((m) => m.id === mode)?.hint}</em>
        </span>
      </div>
      <div className="seg-ctl">
        {RERANK_MODES.map((m) => (
          <button
            key={m.id}
            className={mode === m.id ? 'active' : ''}
            onClick={() => {
              setTest(null);
              onPatch({ mode: m.id });
            }}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === 'local' && (
        <>
          <select
            className="ifield"
            aria-label="Local reranker model"
            value={value.localModel}
            onChange={(e) => {
              setTest(null);
              onPatch({ localModel: e.target.value as LocalRerankModelId });
            }}
          >
            {LOCAL_RERANK_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.detail})
              </option>
            ))}
          </select>
          <p className="muted">{localStatusLabel(status)}</p>
        </>
      )}
      {mode === 'remote' && (
        <>
          <input
            className="ifield"
            placeholder="http://localhost:8080"
            aria-label="Reranker base URL"
            value={local.baseUrl}
            onChange={(e) => setLocal({ ...local, baseUrl: e.target.value })}
            onBlur={() => onPatch({ baseUrl: local.baseUrl })}
          />
          <input
            className="ifield"
            placeholder="bge-reranker-v2-m3"
            aria-label="Reranker model"
            value={local.model}
            onChange={(e) => setLocal({ ...local, model: e.target.value })}
            onBlur={() => onPatch({ model: local.model })}
          />
          <input
            className="ifield"
            type="password"
            placeholder="API key (optional)"
            aria-label="Reranker API key"
            value={local.apiKey ?? ''}
            onChange={(e) => setLocal({ ...local, apiKey: e.target.value })}
            onBlur={() => onPatch({ apiKey: local.apiKey })}
          />
        </>
      )}
      {mode !== 'off' && (
        <div className="retrieval-test">
          <button
            className="retrieval-test-btn"
            onClick={runTest}
            disabled={testing}
            title={testing ? 'Testing…' : 'Test connection'}
            aria-label="Test reranker"
          >
            <Plug size={14} />
            <span>{testing ? 'Testing…' : 'Test connection'}</span>
          </button>
          {!testing && test && (
            <span className={`retrieval-test-status ${test.ok ? 'ok' : 'err'}`} title={test.detail}>
              {test.ok ? <Check size={12} /> : <X size={12} />}
              {test.detail}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Human label for a fact-selection tier, shown in the active-facts summary. */
function tierLabel(t: FactTier): string {
  switch (t) {
    case 'all':
      return 'all (under threshold)';
    case 'embedding':
      return 'embedding + rerank';
    case 'lexical':
      return 'lexical (BM25)';
    case 'recency':
      return 'recency';
  }
}

function FactsTab({ models, activeFacts }: { models: ModelSummary[]; activeFacts: ActiveFactsViewProps }) {
  const { activeThreadId, activeRunning, previewActive, previewDraft, onTogglePreview } = activeFacts;
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [contents, setContents] = useState<MemoryContents | null>(null);
  const [showTech, setShowTech] = useState(false);
  const [showMemories, setShowMemories] = useState(false);
  // Durable facts injected on this chat's last turn, and (when toggled) the set the
  // current draft would inject. Both annotate + sort the stored-facts list below.
  const [lastTurn, setLastTurn] = useState<ActiveFacts | null>(null);
  const [preview, setPreview] = useState<ActiveFacts | null>(null);

  // Refetch the last injected set when the chat changes or finishes a turn (the row
  // is written at turn start, so a running-flag flip means a fresh set is available).
  useEffect(() => {
    let cancelled = false;
    window.stem.getActiveFacts(activeThreadId).then((r) => {
      if (!cancelled) setLastTurn(r);
    });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, activeRunning]);

  // Reveal the stored list when preview turns on, so the re-sorted badges are visible.
  useEffect(() => {
    if (previewActive) setShowMemories(true);
  }, [previewActive]);

  // Debounced draft preview — only runs the (embedding/rerank) selection while the
  // toggle is on; clears immediately when off so stale draft badges don't linger.
  useEffect(() => {
    if (!previewActive) {
      setPreview(null);
      return;
    }
    const text = previewDraft;
    const t = setTimeout(() => {
      window.stem.previewFacts(text).then(setPreview);
    }, 400);
    return () => clearTimeout(t);
  }, [previewActive, previewDraft]);
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMsg, setConsolidateMsg] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  // null => use the backend default model for distillation/tidy-up.
  const [memoryModel, setMemoryModel] = useState<string | null>(null);
  const [retrieval, setRetrieval] = useState<RetrievalSettings | null>(null);
  const [showRetrieval, setShowRetrieval] = useState(false);
  const [embStats, setEmbStats] = useState<EmbeddingCacheStats | null>(null);

  const [refreshing, setRefreshing] = useState(false);

  function loadContents() {
    window.stem.readMemory().then(setContents);
  }

  async function refreshContents() {
    setRefreshing(true);
    try {
      setContents(await holdFullSpin(window.stem.readMemory()));
    } finally {
      setRefreshing(false);
    }
  }
  function loadEmbStats() {
    window.stem.getEmbeddingStats().then(setEmbStats);
  }

  useEffect(() => {
    window.stem.getMemorySettings().then(setSettings);
    window.stem.getSettings().then((s) => {
      setMemoryModel(s.memory.model);
      setRetrieval(s.retrieval);
    });
    loadContents();
    loadEmbStats();
  }, []);

  function selectMemoryModel(id: string | null) {
    setMemoryModel(id);
    window.stem.updateMemorySettings({ model: id }).then((s) => setMemoryModel(s.memory.model));
  }

  function patchEmbeddings(patch: Partial<EmbeddingsSettings>) {
    window.stem.updateRetrievalSettings({ embeddings: patch }).then((s) => setRetrieval(s.retrieval));
  }

  function patchReranker(patch: Partial<RerankerSettings>) {
    window.stem.updateRetrievalSettings({ reranker: patch }).then((s) => setRetrieval(s.retrieval));
  }

  function selectTidyThreshold(n: number) {
    window.stem.setTidyThreshold(n).then(setSettings);
  }

  function selectFactThreshold(n: number) {
    window.stem.setFactThreshold(n).then(setSettings);
  }

  async function toggle() {
    if (!settings) return;
    setSettings(await window.stem.setMemoryEnabled(!settings.enabled));
  }

  async function forget(id: number) {
    setContents(await window.stem.forgetMemory(id));
  }

  async function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    setConsolidateMsg(null);
    try {
      setContents(await window.stem.resetFactsMemory());
      setConsolidateMsg('Facts cleared.');
    } catch {
      setConsolidateMsg('Reset failed — try again.');
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  }

  async function consolidate() {
    setConsolidating(true);
    setConsolidateMsg(null);
    try {
      const r = await holdFullSpin(window.stem.consolidateMemory());
      setContents(r.contents);
      const changed = r.merged + r.corrected + r.dropped;
      setConsolidateMsg(
        changed === 0
          ? 'No duplicates or stale facts found.'
          : `Merged ${r.merged}, corrected ${r.corrected}, dropped ${r.dropped}.`
      );
    } catch {
      setConsolidateMsg('Consolidation failed — try again.');
    } finally {
      setConsolidating(false);
    }
  }

  if (!settings) return <p className="muted">Loading…</p>;

  const notes = contents?.files.filter((f) => f.kind === 'note' && f.content.trim()) ?? [];
  const techFiles = contents?.files.filter((f) => f.kind === 'native' && f.exists && f.content.trim()) ?? [];

  // Which facts are "active": injected last turn, and (when preview is on) the set the
  // current draft would inject. Sort active facts to the top — draft above last-turn —
  // preserving recency order within each group, and badge each row accordingly.
  const lastIds = new Set((lastTurn?.facts ?? []).map((f) => f.id));
  const draftIds = previewActive ? new Set((preview?.facts ?? []).map((f) => f.id)) : null;
  const groupOf = (id?: number): number => {
    if (id == null) return 2;
    if (draftIds?.has(id)) return 0;
    if (lastIds.has(id)) return 1;
    return 2;
  };
  const orderedNotes = notes
    .map((f, i) => ({ f, i, g: groupOf(f.id) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.f);

  return (
    <div>
      <div className="grp-head">Memory</div>
      <div className="group">
        <div className="group-row">
          <span className="row-main">
            <strong>Memory</strong>
            <em>Remember across conversations</em>
          </span>
          <button
            className={`switch${settings.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Memory"
            onClick={toggle}
          />
        </div>
      </div>

      <div className="grp-head">Model</div>
      <div className="formgroup">
        <ModelPicker
          models={models}
          value={memoryModel}
          onChange={selectMemoryModel}
          emptyLabel="Default (recommended)"
          ariaLabel="Memory model"
        />
        <p className="muted">Used to distill and tidy up memories in the background. The skills curator has its own model (under MCP &amp; Skills → Skills).</p>
        <div className="set-block fg-divider">
          <span className="set-sub">Tidy up automatically</span>
          <div className="seg-ctl">
            {TIDY_PRESETS.map((p) => (
              <button
                key={p.label}
                className={settings.tidyThreshold === p.value ? 'active' : ''}
                onClick={() => selectTidyThreshold(p.value)}
                title={`Tidy up ${p.hint}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="muted">Stem merges duplicates and drops stale facts once this many new ones accumulate.</p>
        </div>
      </div>

      {retrieval && (
        <>
          <div className="grp-head">
            <button
              className="memory-view-toggle"
              aria-expanded={showRetrieval}
              onClick={() => {
                if (!showRetrieval) loadEmbStats();
                setShowRetrieval((v) => !v);
              }}
            >
              <ChevronRight size={14} className={showRetrieval ? 'open' : ''} />
              <strong>Relevance ranking (advanced)</strong>
            </button>
          </div>
          {showRetrieval && (
            <div className="formgroup">
              <p className="muted">
                With more than {settings.factThreshold} facts, Stem ranks them by relevance to each message
                instead of injecting them all. The built-in model understands all languages and runs entirely
                on this Mac; you can point Stem at your own embeddings server instead. While no model is
                ready, facts are ranked by keywords/recency.
              </p>
              <div className="set-block">
                <span className="set-sub">Include all facts up to</span>
                <div className="seg-ctl">
                  {FACT_INJECT_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      className={settings.factThreshold === p.value ? 'active' : ''}
                      onClick={() => selectFactThreshold(p.value)}
                      title={`Inject every fact while ${p.value} or fewer are stored; rank by relevance above that`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <p className="muted">
                  Relevance ranking matches by topic, so it can miss facts that matter but aren't topically
                  related to your message (e.g. your family when asking about travel insurance). Keeping this
                  above your stored-fact count ({notes.length}) sends everything with every message — roughly
                  25 facts per 1k tokens.
                </p>
              </div>
              <EmbeddingsFields value={retrieval.embeddings} onPatch={patchEmbeddings} />
              <p className="muted">
                {embStats == null
                  ? 'Embedding cache: …'
                  : embStats.embeddedCount === 0
                    ? `0 of ${embStats.factCount} facts embedded — send a message to build the cache.`
                    : `${embStats.embeddedCount} of ${embStats.factCount} facts embedded${
                        embStats.dim ? ` · ${embStats.dim}-dim vectors` : ''
                      }.`}{' '}
                <button className="link-btn" onClick={loadEmbStats}>
                  Refresh
                </button>
              </p>
              <p className="muted">
                The reranker is a second, precision pass: a cross-encoder re-scores the top embedding
                matches before injection, which is what catches cross-language matches (a Slovak
                question finding an English fact). It applies whichever embeddings mode is active —
                Built-in or Server. While off or not ready, ranking uses embedding similarity alone.
              </p>
              <RerankerFields value={retrieval.reranker} onPatch={patchReranker} />
            </div>
          )}
        </>
      )}

      <div className="memory-view">
        <div className="memory-view-head">
          <button
            className="memory-view-toggle"
            aria-expanded={showMemories}
            onClick={() => setShowMemories((v) => !v)}
          >
            <ChevronRight size={14} className={showMemories ? 'open' : ''} />
            <strong>Stored memory{notes.length ? ` (${notes.length})` : ''}</strong>
          </button>
          <span className="memory-view-actions">
            <button
              className={`link-btn icon-only${previewActive ? ' on' : ''}`}
              onClick={onTogglePreview}
              data-label="Preview draft"
              aria-label="Preview which facts your current draft would inject"
              aria-pressed={previewActive}
            >
              <Eye size={15} />
            </button>
            <button
              className="link-btn icon-only"
              onClick={consolidate}
              disabled={consolidating || !settings.enabled || notes.length < 2}
              data-label={consolidating ? 'Tidying…' : 'Tidy up'}
              aria-label="Tidy up: merge duplicates and drop stale facts"
            >
              <Wand2 size={15} className={consolidating ? 'spin' : undefined} />
            </button>
            <button
              className="link-btn icon-only"
              onClick={refreshContents}
              disabled={refreshing}
              data-label="Refresh"
              aria-label="Refresh facts"
            >
              <RefreshCw size={15} className={refreshing ? 'spin' : undefined} />
            </button>
          </span>
        </div>
        {activeThreadId && lastTurn && (
          <p className="muted active-facts-summary">
            Last turn: {lastTurn.facts.length} {lastTurn.facts.length === 1 ? 'fact' : 'facts'} via{' '}
            {tierLabel(lastTurn.tier)}.
          </p>
        )}
        {previewActive && (
          <p className="muted active-facts-summary">
            {preview
              ? `Draft preview: ${preview.facts.length} ${preview.facts.length === 1 ? 'fact' : 'facts'} via ${tierLabel(preview.tier)}.`
              : 'Draft preview: computing…'}
          </p>
        )}
        {consolidateMsg && <p className="muted">{consolidateMsg}</p>}
        {!contents && <p className="muted">Loading…</p>}
        {showMemories && contents && notes.length === 0 && (
          <p className="muted">No memories stored yet — Stem builds these as you chat.</p>
        )}
        {showMemories &&
          orderedNotes.map((f) => {
            const active = f.id != null && draftIds?.has(f.id) ? 'draft' : f.id != null && lastIds.has(f.id) ? 'injected' : null;
            return (
              <div key={f.name} className={`memory-note${active ? ' active' : ''}`}>
                <div className="memory-note-body">
                  {f.statement ? <p className="statement">{f.statement}</p> : <MdxView text={f.content} />}
                  {active && <span className={`chip active-${active}`}>{active}</span>}
                  {f.source && <span className="chip">{f.source}</span>}
                </div>
                {f.id != null && (
                  <button
                    className="memory-note-forget"
                    title="Forget this"
                    aria-label="Forget this memory"
                    onClick={() => forget(f.id!)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            );
          })}

        {techFiles.length > 0 && (
          <div className="memory-tech">
            <button
              className="memory-tech-head"
              aria-expanded={showTech}
              onClick={() => setShowTech((v) => !v)}
            >
              <ChevronRight size={14} className={showTech ? 'open' : ''} />
              <span>Technical details ({techFiles.length})</span>
            </button>
            {showTech &&
              techFiles.map((f) => (
                <div key={f.name} className="memory-doc">
                  <h4>{f.label}</h4>
                  <MdxView text={f.content} />
                </div>
              ))}
          </div>
        )}

        {(notes.length > 0 || techFiles.length > 0) && (
          <div className="memory-reset">
            {confirmReset ? (
              <span className="memory-reset-confirm">
                <span className="muted">
                  Erase all {notes.length} {notes.length === 1 ? 'fact' : 'facts'}? This can’t be undone.
                </span>
                <button className="link-btn danger" onClick={reset} disabled={resetting}>
                  {resetting ? 'Resetting…' : 'Erase facts'}
                </button>
                <button className="link-btn" onClick={() => setConfirmReset(false)} disabled={resetting}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="link-btn danger memory-reset-trigger"
                onClick={reset}
                title="Permanently erase all durable facts (keeps episodic recall + your files)"
              >
                <Trash2 size={12} /> Reset facts
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SkillsTab({ models }: { models: ModelSummary[] }) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [tidying, setTidying] = useState(false);
  const [collecting, setCollecting] = useState(false);
  // null => use the backend default model for the curator.
  const [curatorModel, setCuratorModel] = useState<string | null>(null);
  useEffect(() => {
    window.stem.listSkills().then(setSkills);
    window.stem.getSettings().then((s) => setCuratorModel(s.skills.model));
    // Refresh when the assistant auto-creates/patches a skill or the curator runs.
    return window.stem.onSkillsChanged(() => {
      window.stem.listSkills().then(setSkills);
    });
  }, []);

  function selectCuratorModel(id: string | null) {
    setCuratorModel(id);
    window.stem.updateSkillsSettings({ model: id }).then((s) => setCuratorModel(s.skills.model));
  }

  async function toggle(slug: string, enabled: boolean) {
    setSkills(await window.stem.setSkillEnabled(slug, enabled));
  }

  async function tidy() {
    setTidying(true);
    try {
      setSkills(await holdFullSpin(window.stem.curateSkills()));
    } finally {
      setTidying(false);
    }
  }

  // "Collect now": rerun the skill distiller over the whole chat backlog (not just
  // a list refresh) — the returned list already reflects anything it wrote.
  async function collect() {
    setCollecting(true);
    try {
      setSkills(await holdFullSpin(window.stem.distillSkillsNow()));
    } finally {
      setCollecting(false);
    }
  }

  // Stem auto-authors and tidies skills; a manual "Tidy up" runs the curator now.
  const hasAgentSkills = skills.some((s) => s.source === 'agent');

  return (
    <div>
      <div className="grp-head with-actions">
        Skills
        <span className="memory-view-actions">
          {hasAgentSkills && (
            <button
              className="link-btn icon-only"
              onClick={tidy}
              disabled={tidying}
              data-label={tidying ? 'Tidying…' : 'Tidy up'}
              aria-label="Tidy up: merge duplicates and archive stale auto-created skills"
            >
              <Wand2 size={15} className={tidying ? 'spin' : undefined} />
            </button>
          )}
          <button
            className="link-btn icon-only"
            onClick={collect}
            disabled={collecting}
            data-label={collecting ? 'Collecting…' : 'Collect now'}
            aria-label="Scan recent chats for new skills now"
          >
            <RefreshCw size={15} className={collecting ? 'spin' : undefined} />
          </button>
        </span>
      </div>
      {skills.length === 0 ? (
        <p className="muted">No skills yet. Stem saves reusable procedures it works out, or you can drop a SKILL.md folder into the skills directory.</p>
      ) : (
        <div className="group">
          {skills.map((s) => (
            <div key={s.slug} className="group-row">
              <span className="row-main">
                <strong>
                  {s.name}
                  {s.source === 'agent' && (
                    <span className="muted" style={{ marginLeft: 6, fontWeight: 400, fontSize: '0.8em' }}>
                      auto{s.version && s.version > 1 ? ` · v${s.version}` : ''}
                    </span>
                  )}
                </strong>
                <em>{s.description}</em>
              </span>
              <button
                className={`switch${s.enabled ? ' on' : ''}`}
                role="switch"
                aria-checked={s.enabled}
                aria-label={s.name}
                onClick={() => toggle(s.slug, !s.enabled)}
              />
            </div>
          ))}
        </div>
      )}

      <div className="grp-head">Curator model</div>
      <div className="formgroup">
        <ModelPicker
          models={models}
          value={curatorModel}
          onChange={selectCuratorModel}
          emptyLabel="Default (recommended)"
          ariaLabel="Skills curator model"
        />
        <p className="muted">
          Runs the background skills curator — merging duplicate skills, sharpening sloppy ones, and
          archiving stale ones. Separate from the memory model so you can give curation a stronger
          model. New skills are still written by the model you chat with; this only affects upkeep.
        </p>
      </div>
    </div>
  );
}

// ---- Folders tab: external folders the assistant reads in place ----
// The user connects folders (an Obsidian vault, a financials folder) by absolute
// path; Stem reads them live, never copying. Per folder: a write toggle (read-only
// is enforced in the backend) and a memorize toggle (off keeps its contents out of
// cross-chat memory — the intended default for a client's private vault).
function FoldersTab() {
  const [folders, setFolders] = useState<ConnectedFolder[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.stem.listConnectedFolders().then(setFolders);
  }, []);

  async function add() {
    setBusy(true);
    try {
      const paths = await window.stem.pickDirectory();
      if (paths.length) setFolders(await window.stem.addConnectedFolders(paths));
    } finally {
      setBusy(false);
    }
  }

  const setMode = async (id: string, writable: boolean) =>
    setFolders(await window.stem.updateConnectedFolder(id, { mode: writable ? 'readwrite' : 'read' }));
  const setMemorize = async (id: string, memorize: boolean) =>
    setFolders(await window.stem.updateConnectedFolder(id, { memorize }));
  const remove = async (id: string) => setFolders(await window.stem.removeConnectedFolder(id));

  return (
    <div>
      <div className="grp-head cfolders-head">
        Connected folders
        <span className="grp-head-actions">
          <button className="grp-head-add" onClick={() => window.stem.openWorkspaceFolder()} title="Open Stem's own folder in Finder" aria-label="Open Stem's folder">
            <FolderOpen size={14} />
          </button>
          <button className="grp-head-add" onClick={add} disabled={busy} title="Connect an external folder Stem can read" aria-label="Add folder">
            <Plus size={14} />
          </button>
        </span>
      </div>

      {folders.length === 0 ? (
        <p className="muted">
          Connect a folder — an Obsidian vault, a project folder — and Stem can read its files in
          place (never copied). Read-only by default; turn off Memorize to keep a private folder's
          contents out of Stem's memory.
        </p>
      ) : (
        <div className="group">
          {folders.map((f) => (
            <div key={f.id} className="cfolder-item">
              <div className="cfolder-head">
                <span className="row-main">
                  <strong>
                    {f.label}
                    {f.missing && <span className="muted cfolder-missing"> · missing</span>}
                  </strong>
                  <em title={f.path}>{f.path}</em>
                </span>
                <button className="icon-action sm" onClick={() => window.stem.revealConnectedFolder(f.id)} title="Reveal in Finder" aria-label="Reveal in Finder">
                  <FolderOpen size={14} />
                </button>
                <button className="icon-action sm" onClick={() => remove(f.id)} title="Disconnect (does not delete the folder)" aria-label="Disconnect folder">
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="cfolder-opts">
                <button
                  className="cfolder-opt"
                  role="switch"
                  aria-checked={f.mode === 'readwrite'}
                  title="Allow Stem to edit files in this folder (off = read-only, enforced by Stem)"
                  onClick={() => setMode(f.id, f.mode !== 'readwrite')}
                >
                  <span>Writable</span>
                  <span className={`switch${f.mode === 'readwrite' ? ' on' : ''}`} />
                </button>
                <button
                  className="cfolder-opt"
                  role="switch"
                  aria-checked={f.memorize}
                  title="Let Stem remember this folder's contents across chats (off = private)"
                  onClick={() => setMemorize(f.id, !f.memorize)}
                >
                  <span>Memorize</span>
                  <span className={`switch${f.memorize ? ' on' : ''}`} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Tasks tab: scheduled autonomous re-runs ----

/** Human-readable schedule, e.g. "cron 0 8 * * 1-5" or "once · Jul 1, 08:00". */
function describeSchedule(task: ScheduledTask): string {
  if (task.schedule.kind === 'cron') return `cron · ${task.schedule.expr}`;
  return `once · ${formatWhen(task.schedule.at)}`;
}

/** Compact local datetime, e.g. "Jul 1, 08:00". */
function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function TasksTab({ onOpenChat }: { onOpenChat: (threadId: string) => void }) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);

  useEffect(() => {
    window.stem.listTasks().then(setTasks);
    // Stay in sync as runs fire / the assistant schedules new tasks.
    return window.stem.onTasksChanged(setTasks);
  }, []);

  const toggle = async (t: ScheduledTask) => setTasks(await window.stem.setTaskEnabled(t.id, !t.enabled));
  const runNow = async (t: ScheduledTask) => setTasks(await window.stem.runTaskNow(t.id));
  const remove = async (t: ScheduledTask) => setTasks(await window.stem.deleteTask(t.id));

  return (
    <div>
      <div className="grp-head">Scheduled tasks</div>
      {tasks.length === 0 ? (
        <p className="muted">
          No scheduled tasks yet. Ask Stem in a chat to do something on a schedule — “every weekday
          at 8, summarize my unread email” or “check this page hourly and let me know if it changes”.
          The task runs in that chat and only interrupts you when there’s something worth seeing.
        </p>
      ) : (
        <div className="group">
          {tasks.map((t) => (
            <div key={t.id} className={`task-item${t.enabled ? '' : ' paused'}`}>
              <div className="task-head">
                <span className="row-main">
                  <strong title={t.prompt}>{t.title}</strong>
                  <em>{describeSchedule(t)}</em>
                </span>
                <button
                  className="icon-action sm"
                  onClick={() => onOpenChat(t.threadId)}
                  title="Open the chat this task runs in"
                  aria-label="Open chat"
                >
                  <ExternalLink size={14} />
                </button>
                <button
                  className="icon-action sm"
                  onClick={() => runNow(t)}
                  title="Run now"
                  aria-label="Run now"
                  disabled={t.lastStatus === 'running'}
                >
                  <Play size={14} />
                </button>
                <button
                  className="icon-action sm"
                  onClick={() => toggle(t)}
                  title={t.enabled ? 'Pause' : 'Resume'}
                  aria-label={t.enabled ? 'Pause' : 'Resume'}
                >
                  {t.enabled ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  className="icon-action sm"
                  onClick={() => remove(t)}
                  title="Delete task"
                  aria-label="Delete task"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="task-meta muted">
                {t.lastStatus === 'running' ? (
                  <span className="task-running">Running now…</span>
                ) : (
                  <>
                    {t.enabled ? (
                      <span>Next: {formatWhen(t.nextRunAt)}</span>
                    ) : (
                      <span>Paused</span>
                    )}
                    {t.lastRunAt && (
                      <span>
                        {' · '}Last: {formatWhen(t.lastRunAt)}
                        {t.lastStatus === 'failed' ? ' (failed)' : ''}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Settings tab: Quick Chat overlay configuration ----

// macOS canonical modifier order (⌃⌥⇧⌘) and their glyphs.
const MOD_ORDER = ['Control', 'Alt', 'Shift', 'Command'];
const MOD_GLYPH: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
// The hyperkey fires all four modifiers at once; we collapse them to one icon.
const HYPER_MODS = ['Command', 'Control', 'Alt', 'Shift'];

/**
 * Map a physical `KeyboardEvent.code` to an Electron accelerator key token.
 * Using `code` (not `key`) is essential: with Option held, macOS composes
 * `key` into a non-ASCII glyph (Option+J → "∆"), which Electron's accelerator
 * parser rejects. `code` is layout- and modifier-independent. Returns null for
 * unsupported/pure-modifier keys.
 */
function codeToAccelerator(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // KeyJ -> J
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit1 -> 1
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code; // F1..F24
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  const NUMPAD: Record<string, string> = {
    NumpadDecimal: 'numdec',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadEnter: 'Return'
  };
  if (code in NUMPAD) return NUMPAD[code];
  const MAP: Record<string, string> = {
    Space: 'Space',
    Enter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`'
  };
  return MAP[code] ?? null;
}

/** Render an Electron accelerator ('Control+Alt+J') as mac glyphs, collapsing a
 *  full four-modifier hyperkey into a single hyper icon. */
function renderAccelerator(accel: string): ReactNode {
  const parts = accel.split('+');
  const mods = parts.filter((p) => HYPER_MODS.includes(p)).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  const keys = parts.filter((p) => !HYPER_MODS.includes(p));
  const isHyper = HYPER_MODS.every((m) => mods.includes(m));
  return (
    <span className="accel">
      {isHyper ? (
        <span className="accel-hyper" aria-label="Hyper">✦</span>
      ) : (
        mods.map((m) => MOD_GLYPH[m] ?? m).join('')
      )}
      {keys.join('')}
    </span>
  );
}

function ShortcutRecorder({
  value,
  onChange
}: {
  value: string | null;
  onChange: (accel: string | null) => void;
}) {
  const [recording, setRecording] = useState(false);

  function onKeyDown(e: React.KeyboardEvent) {
    e.preventDefault();
    if (e.code === 'Escape') {
      setRecording(false);
      return;
    }
    const main = codeToAccelerator(e.code);
    if (!main) return; // waiting for a non-modifier / supported key
    const mods: string[] = [];
    if (e.metaKey) mods.push('Command');
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (mods.length === 0) return; // a global shortcut needs a modifier
    onChange([...mods, main].join('+'));
    setRecording(false);
  }

  return (
    <button
      className={`recorder${recording ? ' recording' : ''}`}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={recording ? onKeyDown : undefined}
    >
      <span>{recording ? 'Press keys…' : value ? renderAccelerator(value) : 'Click to record'}</span>
      {value && !recording && (
        <span
          className="recorder-clear"
          title="Clear shortcut"
          onClick={(e) => {
            e.stopPropagation();
            onChange(null);
          }}
        >
          <X size={12} />
        </span>
      )}
    </button>
  );
}

// ---- AI providers (Settings → top section) ----

const OAUTH_CHOICES: { id: AuthProviderId; hint: string }[] = [
  { id: 'openai-codex', hint: 'Sign in with a ChatGPT Plus or Pro subscription.' },
  { id: 'anthropic', hint: 'Sign in with a Claude Pro or Max subscription.' }
];

/** How a connected provider signed in — shown as the row's secondary line. */
function providerKind(id: string): string {
  if (id === 'openai-codex') return 'ChatGPT subscription';
  if (isLocalProviderId(id)) return 'Local server';
  return 'API key / subscription';
}

/**
 * Provider management, mirroring the MCP Servers tab: connected providers as a
 * grouped list with a +/− gutter; the + button opens an Add Provider form with
 * an account / API key / local-server segmented choice. Runs against the same
 * auth IPC as the onboarding wizard.
 */
function ProvidersSection() {
  const [providers, setProviders] = useState<string[]>([]);
  const [local, setLocal] = useState<LocalProvidersSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The Add Provider form is collapsed behind the + button (like the MCP tab's
  // Add Server) so the steady state is a calm list of connected providers.
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'account' | 'apikey' | 'local'>('account');
  // In-flight OAuth attempt (null = none). Mirrors the onboarding wizard's
  // oauthWait/manualInput steps in miniature; completion resolves the
  // providerLogin promise, so `done` events only clear transient state.
  const [oauth, setOauth] = useState<{
    provider: AuthProviderId;
    authUrl: string | null;
    progress: string | null;
    input: { requestId: string; message: string; placeholder?: string } | null;
  } | null>(null);

  const refresh = useCallback(async () => {
    const [status, settings] = await Promise.all([window.stem.runtimeStatus(), window.stem.getSettings()]);
    setProviders(status.providers ?? []);
    setLocal(settings.localProviders);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      window.stem.onAuthEvent((e) => {
        setOauth((cur) => {
          if (!cur) return cur;
          switch (e.kind) {
            case 'auth-url':
              return { ...cur, authUrl: e.url };
            case 'progress':
              return { ...cur, progress: e.message };
            case 'input-request':
              return { ...cur, input: { requestId: e.requestId, message: e.message, placeholder: e.placeholder } };
            default:
              return cur;
          }
        });
      }),
    []
  );

  /** Providers changed: refresh this section AND tell App to reload status+models. */
  const changed = useCallback(async () => {
    await refresh();
    window.dispatchEvent(new CustomEvent('stem:providers-changed'));
  }, [refresh]);

  function closeForm() {
    setAdding(false);
    setMode('account');
  }

  async function startOAuth(provider: AuthProviderId) {
    setError(null);
    setOauth({ provider, authUrl: null, progress: null, input: null });
    try {
      const res = await window.stem.providerLogin(provider);
      if (!res.ok) setError(res.error ?? 'Sign-in failed.');
      else {
        await changed();
        closeForm();
      }
    } finally {
      setOauth(null);
    }
  }

  function cancelOAuth() {
    void window.stem.providerLoginCancel();
    setOauth(null);
  }

  async function disconnect(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await window.stem.disconnectProvider(id);
      if (!res.ok) setError(res.error ?? 'Could not disconnect.');
      else {
        setSelected(null);
        await changed();
      }
    } finally {
      setBusy(false);
    }
  }

  // Cloud rows come from auth.json keys; local rows from enabled servers.
  const cloudProviders = providers.filter((p) => !isLocalProviderId(p));
  const enabledLocals = local ? (Object.keys(local) as LocalProviderId[]).filter((id) => local[id].enabled) : [];
  const rows = [
    ...cloudProviders.map((id) => ({ id, local: false, detail: providerKind(id) })),
    ...enabledLocals.map((id) => ({ id, local: true, detail: local![id].baseUrl }))
  ];

  return (
    <>
      <div className="grp-head">AI Providers</div>
      {rows.length === 0 ? (
        <div className="group">
          <div className="group-row">
            <span className="row-main">
              <em>No providers yet. Add one with the + button.</em>
            </span>
          </div>
        </div>
      ) : (
        <div className="group">
          {rows.map((row) => (
            <div
              key={row.id}
              className={`group-row${selected === row.id ? ' selected' : ''}`}
              onClick={() => setSelected(row.id)}
            >
              <span className={`row-icon ${row.local ? 'local' : 'remote'}`}>
                {row.local ? <HardDrive size={14} /> : <Globe size={14} />}
              </span>
              <span className="row-main">
                <strong>{providerName(row.id)}</strong>
                <em>{row.detail}</em>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="gutter">
        <button title="Add provider" onClick={() => setAdding(true)}>
          <Plus size={15} />
        </button>
        <button
          title="Disconnect selected"
          onClick={() => selected && void disconnect(selected)}
          disabled={!selected || busy}
        >
          <Minus size={15} />
        </button>
      </div>

      {adding && (
        <>
          <div className="grp-head">Add Provider</div>
          <div className="formgroup">
            {!oauth && (
              <>
                <div className="seg-ctl">
                  <button className={mode === 'account' ? 'active' : ''} onClick={() => setMode('account')}>
                    Account
                  </button>
                  <button className={mode === 'apikey' ? 'active' : ''} onClick={() => setMode('apikey')}>
                    API key
                  </button>
                  <button className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>
                    Local server
                  </button>
                </div>
                {mode === 'account' && (
                  <ProviderAccountForm onConnect={(id) => void startOAuth(id)} onCancel={closeForm} />
                )}
                {mode === 'apikey' && (
                  <ProviderApiKeyForm
                    onSaved={async () => {
                      await changed();
                      closeForm();
                    }}
                    onError={setError}
                    onCancel={closeForm}
                  />
                )}
                {mode === 'local' && local && (
                  <LocalServerAddForm
                    settings={local}
                    onSaved={async () => {
                      await changed();
                      closeForm();
                    }}
                    onError={setError}
                    onCancel={closeForm}
                  />
                )}
              </>
            )}

            {oauth && !oauth.input && (
              <div className="set-block">
                <span className="set-sub">Waiting for your browser…</span>
                <p className="muted">
                  Finish signing in to {providerName(oauth.provider)} in your browser — Stem continues automatically.
                </p>
                {oauth.authUrl && (
                  <p className="muted">
                    Nothing happened? Open this link yourself: <code className="login-cmd">{oauth.authUrl}</code>
                  </p>
                )}
                {oauth.progress && <p className="muted">{oauth.progress}</p>}
                <div className="push-row">
                  <button className="push" onClick={cancelOAuth}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {oauth?.input && (
              <ProviderManualCode
                message={oauth.input.message}
                placeholder={oauth.input.placeholder}
                onSubmit={(value) => {
                  void window.stem.providerLoginRespond(oauth.input!.requestId, value);
                  setOauth({ ...oauth, input: null });
                }}
                onCancel={cancelOAuth}
              />
            )}
          </div>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </>
  );
}

/** Subscription sign-in (ChatGPT / Claude): pick the account, then Connect. */
function ProviderAccountForm({
  onConnect,
  onCancel
}: {
  onConnect: (id: AuthProviderId) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<AuthProviderId>('openai-codex');
  const choice = OAUTH_CHOICES.find((c) => c.id === provider)!;
  return (
    <div className="set-block">
      <select
        className="ifield"
        aria-label="Account provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as AuthProviderId)}
      >
        {OAUTH_CHOICES.map((c) => (
          <option key={c.id} value={c.id}>
            {providerName(c.id)}
          </option>
        ))}
      </select>
      <p className="muted">{choice.hint}</p>
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="push default" onClick={() => onConnect(provider)}>
          Connect
        </button>
      </div>
    </div>
  );
}

function ProviderManualCode({
  message,
  placeholder,
  onSubmit,
  onCancel
}: {
  message: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <form
      className="set-block"
      onSubmit={(e) => {
        e.preventDefault();
        const value = inputRef.current?.value.trim();
        if (value) onSubmit(value);
      }}
    >
      <span className="set-sub">{message}</span>
      <input ref={inputRef} className="ifield" type="text" placeholder={placeholder ?? 'Paste the code here'} autoFocus />
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="push default">
          Continue
        </button>
      </div>
    </form>
  );
}

function ProviderApiKeyForm({
  onSaved,
  onError,
  onCancel
}: {
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<ApiKeyProviderId>('anthropic');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="set-block"
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = key.trim();
        if (!trimmed) return;
        setSaving(true);
        onError(null);
        try {
          const res = await window.stem.setApiKey(provider, trimmed);
          if (!res.ok) onError(res.error ?? 'The API key could not be saved.');
          else {
            setKey('');
            await onSaved();
          }
        } finally {
          setSaving(false);
        }
      }}
    >
      <select
        className="ifield"
        aria-label="API key provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as ApiKeyProviderId)}
      >
        {API_KEY_PROVIDER_IDS.map((id) => (
          <option key={id} value={id}>
            {providerName(id)}
          </option>
        ))}
      </select>
      <input
        className="ifield"
        type="password"
        placeholder="sk-…"
        aria-label="API key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoFocus
      />
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="push default" disabled={saving || !key.trim()}>
          {saving ? 'Saving…' : 'Save key'}
        </button>
      </div>
    </form>
  );
}

/**
 * Add a local model server (Ollama / LM Studio): pick the server, adjust the
 * URL if needed, optionally Test, then Enable. Editing later = disconnect (−)
 * and re-add, matching the MCP servers list.
 */
function LocalServerAddForm({
  settings,
  onSaved,
  onError,
  onCancel
}: {
  settings: LocalProvidersSettings;
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
  onCancel: () => void;
}) {
  const [server, setServer] = useState<LocalProviderId>('ollama');
  const [baseUrl, setBaseUrl] = useState(settings.ollama.baseUrl);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<LocalProviderTestResult | null>(null);
  const [saving, setSaving] = useState(false);

  function pick(id: LocalProviderId) {
    setServer(id);
    setBaseUrl(settings[id].baseUrl);
    setTest(null);
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await window.stem.testLocalProvider(server, baseUrl));
    } catch {
      setTest({ ok: false, error: 'request failed' });
    } finally {
      setTesting(false);
    }
  }

  async function enable() {
    setSaving(true);
    onError(null);
    try {
      const res = await window.stem.updateLocalProvider(server, { enabled: true, baseUrl: baseUrl.trim() });
      if (!res.ok) onError(res.error ?? 'Could not enable the server.');
      else await onSaved();
    } finally {
      setSaving(false);
    }
  }

  const testLabel = test
    ? test.ok
      ? `${test.models?.length ?? 0} model${(test.models?.length ?? 0) === 1 ? '' : 's'} found` +
        (test.skippedNoTools ? ` (${test.skippedNoTools} without tool support hidden)` : '')
      : test.error ?? 'failed'
    : null;

  return (
    <div className="set-block">
      <select
        className="ifield"
        aria-label="Local server"
        value={server}
        onChange={(e) => pick(e.target.value as LocalProviderId)}
      >
        {(Object.keys(settings) as LocalProviderId[]).map((id) => (
          <option key={id} value={id}>
            {providerName(id)}
          </option>
        ))}
      </select>
      <input
        className="ifield"
        aria-label={`${providerName(server)} base URL`}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <div className="retrieval-test">
        <button
          className="retrieval-test-btn"
          onClick={() => void runTest()}
          disabled={testing}
          title={testing ? 'Testing…' : 'Test connection'}
          aria-label={`Test ${providerName(server)} connection`}
        >
          <Plug size={14} />
          <span>{testing ? 'Testing…' : 'Test connection'}</span>
        </button>
        {!testing && testLabel && (
          <span className={`retrieval-test-status ${test!.ok ? 'ok' : 'err'}`} title={testLabel}>
            {test!.ok ? <Check size={12} /> : <X size={12} />}
            {testLabel}
          </span>
        )}
      </div>
      {server === 'lmstudio' && (
        <p className="muted">LM Studio loads a model on first use — the first reply can take a while.</p>
      )}
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="push default"
          disabled={saving || !baseUrl.trim()}
          onClick={() => void enable()}
        >
          {saving ? 'Enabling…' : 'Enable'}
        </button>
      </div>
    </div>
  );
}

function SettingsTab({ models, modelId, onSelectModel }: ModelTabProps) {
  const [qc, setQc] = useState<QuickChatSettings | null>(null);
  const [nws, setNws] = useState<NativeWebSearchSettings>({ main: true, quickChat: true });
  const [escapeAction, setEscapeAction] = useState<EscapeAction>('off');
  const [ci, setCi] = useState<CustomInstructionsSettings>({ main: '', quickChat: '' });
  // Per-field debounce so typing doesn't spam the atomic settings writer.
  const ciMainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ciQuickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedModel = models.find((m) => m.id === modelId) ?? null;

  useEffect(() => {
    window.stem.getSettings().then((s) => {
      setQc(s.quickChat);
      setNws(s.nativeWebSearch);
      setEscapeAction(s.escapeAction);
      setCi(s.customInstructions);
    });
  }, []);

  function saveCiMain(value: string) {
    setCi((c) => ({ ...c, main: value }));
    if (ciMainTimer.current) clearTimeout(ciMainTimer.current);
    ciMainTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ main: value }), 400);
  }

  function saveCiQuick(value: string) {
    setCi((c) => ({ ...c, quickChat: value }));
    if (ciQuickTimer.current) clearTimeout(ciQuickTimer.current);
    ciQuickTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ quickChat: value }), 400);
  }

  function selectEscapeAction(action: EscapeAction) {
    setEscapeAction(action); // optimistic; persist + reconcile from the saved settings
    // Notify the main window's composer (App) so the new mode applies immediately,
    // without waiting for a window focus cycle.
    window.dispatchEvent(new CustomEvent('stem:escape-action', { detail: action }));
    window.stem.updateEscapeAction(action).then((s) => setEscapeAction(s.escapeAction));
  }

  function update(patch: Partial<QuickChatSettings>) {
    window.stem.updateQuickChat(patch).then((s) => setQc(s.quickChat));
  }

  function toggleNativeSearch(key: keyof NativeWebSearchSettings, enabled: boolean) {
    window.stem.updateNativeWebSearch({ [key]: enabled }).then((s) => setNws(s.nativeWebSearch));
  }

  if (!qc) return <p className="muted">Loading…</p>;

  // The Quick Chat default-effort options follow the chosen default model's capabilities.
  // "Same as main" (empty) has no concrete model here, so offer all levels.
  const qcModel = qc.defaultModel ? models.find((m) => m.id === qc.defaultModel) : undefined;
  const qcEfforts = qcModel?.supportedEfforts.length ? qcModel.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
  // Only models with a priority (Fast) tier can default to Fast. With no concrete model
  // ("Same as main"), offer it — the runtime ignores Fast on models that don't support it.
  const qcHasFast = qcModel ? qcModel.serviceTiers.some((t) => t.id === 'priority') : true;

  // Switch the default model, clamping a now-unsupported saved effort/speed into range.
  function selectQcModel(id: string | null) {
    const m = id ? models.find((x) => x.id === id) : undefined;
    const efforts = m?.supportedEfforts.length ? m.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
    const patch: Partial<QuickChatSettings> = { defaultModel: id };
    if (qc && !efforts.includes(qc.defaultEffort)) patch.defaultEffort = m?.defaultEffort ?? efforts[0];
    // Drop a saved Fast default when the new model has no priority tier.
    if (qc?.defaultServiceTier === 'priority' && m && !m.serviceTiers.some((t) => t.id === 'priority')) {
      patch.defaultServiceTier = null;
    }
    update(patch);
  }

  return (
    <div>
      <div className="grp-head">Model</div>
      <div className="formgroup">
        {models.length === 0 ? (
          <p className="muted">Loading models…</p>
        ) : (
          <>
            <ModelPicker
              models={models}
              value={modelId}
              onChange={(id) => onSelectModel(id ?? '')}
              ariaLabel="Model"
            />
            {selectedModel?.supportsNativeWebSearch && (
              <label className="set-check" title="Search the live web for current info, with citations">
                <input
                  type="checkbox"
                  checked={nws.main}
                  onChange={(e) => toggleNativeSearch('main', e.target.checked)}
                />
                Native web search
              </label>
            )}
          </>
        )}
      </div>

      <ProvidersSection />

      <div className="grp-head">Files</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Files folder</strong>
            <em>Drop files here for Stem to read across chats</em>
          </span>
          <button
            className="icon-action"
            title="Open in Finder"
            aria-label="Open Files folder in Finder"
            onClick={() => window.stem.revealFiles()}
          >
            <FolderOpen size={16} />
          </button>
        </div>
      </div>

      <div className="grp-head">Input</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">Escape key</span>
          <div className="seg-ctl">
            <button
              className={escapeAction === 'off' ? 'active' : ''}
              onClick={() => selectEscapeAction('off')}
              title="Escape does nothing in the composer"
            >
              Off
            </button>
            <button
              className={escapeAction === 'single' ? 'active' : ''}
              onClick={() => selectEscapeAction('single')}
              title="One Escape stops the turn and pulls your message back into the composer"
            >
              Single
            </button>
            <button
              className={escapeAction === 'twoStage' ? 'active' : ''}
              onClick={() => selectEscapeAction('twoStage')}
              title="First Escape stops the turn; a second Escape retracts your message"
            >
              Two-stage
            </button>
          </div>
          <p className="muted">
            While a reply is streaming, Escape can stop it and return your just-sent message to the composer to edit
            — as if you never sent it.
          </p>
        </div>
      </div>

      <div className="grp-head">Custom instructions</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">Standing instructions</span>
          <textarea
            className="ci-textarea"
            value={ci.main}
            onChange={(e) => saveCiMain(e.target.value)}
            rows={5}
            placeholder="e.g. Reply briefly and to the point. Use plain Markdown unless I ask for components."
          />
          <p className="muted">
            High-priority directives Stem follows in every reply — in the main app and in Quick Chat. Stem can also
            update these itself when you ask it to.
          </p>
        </div>
      </div>

      <div className="grp-head">Quick Chat</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Global shortcut</strong>
            <em>Summon the quick-chat overlay from anywhere</em>
          </span>
          <ShortcutRecorder value={qc.shortcut} onChange={(accel) => update({ shortcut: accel })} />
        </div>

        <div className="set-block">
          <span className="set-sub">Default model</span>
          <ModelPicker
            models={models}
            value={qc.defaultModel}
            onChange={selectQcModel}
            emptyLabel="Same as main"
            ariaLabel="Quick Chat default model"
          />
          {qcModel?.supportsNativeWebSearch && (
            <label className="set-check" title="Search the live web for current info, with citations">
              <input
                type="checkbox"
                checked={nws.quickChat}
                onChange={(e) => toggleNativeSearch('quickChat', e.target.checked)}
              />
              Native web search
            </label>
          )}
        </div>

        <div className="set-block">
          <span className="set-sub">Default effort</span>
          <div className="seg-ctl">
            {qcEfforts.map((e) => (
              <button key={e} className={qc.defaultEffort === e ? 'active' : ''} onClick={() => update({ defaultEffort: e })}>
                {EFFORT_LABELS[e] ?? e}
              </button>
            ))}
          </div>
        </div>

        {qcHasFast && (
          <div className="set-block">
            <span className="set-sub">Default speed</span>
            <div className="seg-ctl">
              <button
                className={qc.defaultServiceTier === 'priority' ? '' : 'active'}
                onClick={() => update({ defaultServiceTier: null })}
              >
                Standard
              </button>
              <button
                className={qc.defaultServiceTier === 'priority' ? 'active' : ''}
                onClick={() => update({ defaultServiceTier: 'priority' })}
                title="1.5× speed, increased usage"
              >
                Fast
              </button>
            </div>
          </div>
        )}

        <div className="set-row">
          <span className="set-label">
            <strong>Show on all displays</strong>
            <em>Float above every Space &amp; the active display</em>
          </span>
          <button
            className={`switch${qc.showOnAllDisplays ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.showOnAllDisplays}
            aria-label="Show on all displays"
            onClick={() => update({ showOnAllDisplays: !qc.showOnAllDisplays })}
          />
        </div>

        <div className="set-row">
          <span className="set-label">
            <strong>Show progress on other Spaces</strong>
            <em>Float the progress pill when the main window loses focus &amp; a thread is running</em>
          </span>
          <button
            className={`switch${qc.followAcrossSpaces ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.followAcrossSpaces}
            aria-label="Show progress on other Spaces"
            onClick={() => update({ followAcrossSpaces: !qc.followAcrossSpaces })}
          />
        </div>

        <div className="set-row">
          <span className="set-label">
            <strong>Sound when finished</strong>
            <em>Play a chime when a turn finishes while the progress pill is visible</em>
          </span>
          <button
            className={`switch${qc.finishSound ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.finishSound}
            aria-label="Sound when finished"
            onClick={() => update({ finishSound: !qc.finishSound })}
          />
        </div>

        <div className="set-block">
          <span className="set-sub">New thread after idle</span>
          <div className="seg-ctl">
            {NEW_THREAD_PRESETS.map((p) => (
              <button
                key={p.label}
                className={qc.newThreadTimeoutMs === p.ms ? 'active' : ''}
                onClick={() => update({ newThreadTimeoutMs: p.ms })}
                title="Re-summoning the overlay after this idle time starts a fresh thread"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="set-block">
          <span className="set-sub">Extra instructions</span>
          <textarea
            className="ci-textarea"
            value={ci.quickChat}
            onChange={(e) => saveCiQuick(e.target.value)}
            rows={4}
            placeholder="e.g. Be even more terse here — one or two sentences."
          />
          <p className="muted">Layered on top of your main custom instructions, only in the Quick Chat overlay.</p>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 'var(--sp-5)' }}>
        Press the shortcut to open the overlay; Escape or the shortcut again hides it.
      </p>
    </div>
  );
}

// Combined panel: MCP servers and Skills live under the same icon as two sub-tabs.
function McpSkillsTab({ models }: { models: ModelSummary[] }) {
  const [sub, setSub] = useState<'mcp' | 'skills'>('mcp');
  return (
    <div>
      <div className="seg-ctl">
        <button className={sub === 'mcp' ? 'active' : ''} onClick={() => setSub('mcp')}>
          MCP servers
        </button>
        <button className={sub === 'skills' ? 'active' : ''} onClick={() => setSub('skills')}>
          Skills
        </button>
      </div>
      {sub === 'mcp' ? <McpTab /> : <SkillsTab models={models} />}
    </div>
  );
}

function McpTab() {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [transport, setTransport] = useState<McpTransport>('http');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [envText, setEnvText] = useState('');
  // Optional static OAuth client for remote servers without dynamic registration
  // (e.g. Slack): you pre-register an app with the provider and paste its creds.
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthScope, setOauthScope] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loginName, setLoginName] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<McpLoginUrlParams | null>(null);
  // Live per-server connection status from the running app-server. This is the
  // source of truth for whether a remote server actually works — `authStatus`
  // only says whether OAuth creds exist on disk, which stays 'o_auth' even when
  // the token is rejected at connect time and the server exposes no tools.
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [selected, setSelected] = useState<string | null>(null);
  // The Add Server form is collapsed by default — the + button reveals it — so the
  // panel stays calm when you're just reviewing servers. `showAdvanced` hides headers
  // and the static OAuth client fields behind a disclosure (most adds are Name + URL).
  const [adding, setAdding] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    const [list, status] = await Promise.all([
      window.stem.listMcpServers(),
      window.stem.getMcpStatus()
    ]);
    setServers(list);
    setStatuses(status);
  }

  useEffect(() => {
    refresh();
    // The assistant can add/remove servers itself; refresh the list when it does.
    const offChanged = window.stem.onMcpChanged(() => refresh());
    // Live connection-status updates (e.g. a server goes ready/failed).
    const offStatus = window.stem.onMcpStatus((s) => setStatuses(s));
    return () => {
      offChanged();
      offStatus();
    };
  }, []);

  // The OAuth authorize URL is streamed mid-login as a fallback link.
  useEffect(() => {
    return window.stem.onBackendEvent((event: BackendEventEnvelope) => {
      if (event.method === 'mcp/login/url') setLoginUrl(event.params as McpLoginUrlParams);
    });
  }, []);

  // Focus the Name field once the form has mounted (the + button opens it).
  useEffect(() => {
    if (adding) nameRef.current?.focus();
  }, [adding]);

  // Apply config/token changes to the live session without an app restart.
  async function reconnect() {
    setBusy('Reconnecting…');
    try {
      await window.stem.restartRuntime();
    } finally {
      setBusy(null);
    }
  }

  const canAdd =
    !!name.trim() && (transport === 'http' ? !!url.trim() : !!command.trim()) && !busy;

  // Collapse the Add Server form and reset every field + disclosure to a clean slate.
  function closeForm() {
    setAdding(false);
    setShowAdvanced(false);
    setName('');
    setCommand('');
    setArgs('');
    setUrl('');
    setEnvText('');
    setOauthClientId('');
    setOauthClientSecret('');
    setOauthScope('');
    setError(null);
  }

  // Parse the env textarea ("KEY=value" per line) into a map; blank/`#` lines skipped.
  function parseEnv(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  }

  // Parse the headers textarea ("Key: value" or "Key=value" per line).
  function parseHeaders(text: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = trimmed.search(/[:=]/);
      if (i <= 0) continue;
      headers[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
    }
    return headers;
  }

  async function add() {
    setError(null);
    try {
      const headers = transport === 'http' ? parseHeaders(envText) : {};
      const env = transport === 'http' ? {} : parseEnv(envText);
      const list = await window.stem.addMcpServer({
        name: name.trim(),
        transport,
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        url: url.trim(),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(transport === 'http' && oauthClientId.trim() ? { oauthClientId: oauthClientId.trim() } : {}),
        ...(transport === 'http' && oauthClientSecret.trim() ? { oauthClientSecret: oauthClientSecret.trim() } : {}),
        ...(transport === 'http' && oauthScope.trim() ? { oauthScope: oauthScope.trim() } : {})
      });
      setServers(list);
      closeForm();
      await reconnect();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function remove(serverName: string) {
    setError(null);
    setServers(await window.stem.removeMcpServer(serverName));
    setSelected((cur) => (cur === serverName ? null : cur));
    setStatuses((prev) => {
      const next = { ...prev };
      delete next[serverName];
      return next;
    });
    await reconnect();
  }

  // Toggle a server on/off without removing it. The bridge only reads mcp.json on
  // (re)start, so a reconnect is required for the change to take effect.
  async function toggleEnabled(serverName: string, enabled: boolean) {
    setError(null);
    setServers(await window.stem.setMcpServerEnabled(serverName, enabled));
    await reconnect();
  }

  async function signIn(serverName: string) {
    setError(null);
    setLoginName(serverName);
    setLoginUrl(null);
    try {
      const result = await window.stem.loginMcpServer(serverName);
      if (result.ok) {
        // reconnect() respawns the app-server, which clears stale statuses and
        // re-emits fresh ones; refresh() then pulls the new snapshot.
        await reconnect();
        await refresh();
      } else {
        setError(result.error ?? 'Sign in failed.');
      }
    } finally {
      setLoginName(null);
      setLoginUrl(null);
    }
  }

  /**
   * Resolve how a remote (http) server should present. Live connection status
   * wins; we fall back to `authStatus` only when the app-server hasn't reported
   * yet (e.g. the panel opened before any thread started this session).
   *   connected — handshook, tools available
   *   failed    — dropped at connect time (OAuth token rejected → offer re-login)
   *   pending   — still starting
   *   needs-login — remote server with no usable credentials
   */
  function remoteState(s: McpServerSummary): 'connected' | 'failed' | 'pending' | 'needs-login' {
    const live = statuses[s.name]?.status;
    if (live === 'ready') return 'connected';
    if (live === 'failed') return 'failed';
    if (live === 'starting') return 'pending';
    const hasCreds = s.authStatus === 'o_auth' || s.authStatus === 'bearer_token';
    return hasCreds ? 'connected' : 'needs-login';
  }

  function signInLabel(serverName: string, state: 'failed' | 'needs-login'): string {
    if (loginName === serverName) return 'Waiting…';
    return state === 'failed' ? 'Reconnect' : 'Sign in';
  }

  return (
    <div>
      <div className="grp-head">MCP Servers</div>
      {servers.length === 0 ? (
        <div className="group">
          <div className="group-row">
            <span className="row-main">
              <em>No servers yet. Add one with the + button.</em>
            </span>
          </div>
        </div>
      ) : (
        <div className="group">
          {servers.map((s) => {
            const remote = s.transport === 'http';
            const state = remote ? remoteState(s) : null;
            const needsLogin = state === 'failed' || state === 'needs-login';
            const error = statuses[s.name]?.error ?? undefined;
            return (
              <div
                key={s.name}
                className={`group-row${selected === s.name ? ' selected' : ''}${s.enabled ? '' : ' disabled'}`}
                onClick={() => setSelected(s.name)}
              >
                <span className={`row-icon ${remote ? 'remote' : 'local'}`}>
                  {remote ? <Globe size={14} /> : <HardDrive size={14} />}
                </span>
                <span className="row-main">
                  <strong>{s.name}</strong>
                  <em title={s.enabled && state === 'failed' ? error : undefined} className={s.enabled && state === 'failed' ? 'mcp-failed' : undefined}>
                    {s.enabled && state === 'failed'
                      ? 'Connection failed — sign in again.'
                      : remote
                        ? s.url
                        : `${s.command} ${s.args.join(' ')}`.trim()}
                  </em>
                </span>
                {!s.enabled ? (
                  <span className="pill off">Disabled</span>
                ) : remote && needsLogin ? (
                  <button
                    className="push"
                    onClick={(e) => {
                      e.stopPropagation();
                      signIn(s.name);
                    }}
                    disabled={!!loginName || !!busy}
                  >
                    {signInLabel(s.name, state)}
                  </button>
                ) : remote ? (
                  <span
                    className={`mcp-dot${state === 'pending' ? ' pending' : ''}`}
                    title={state === 'pending' ? 'Connecting…' : 'Connected'}
                    aria-label={state === 'pending' ? 'Connecting' : 'Connected'}
                  />
                ) : (
                  <span className="pill off">Local</span>
                )}
                <button
                  className={`switch${s.enabled ? ' on' : ''}`}
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`${s.name} enabled`}
                  title={s.enabled ? 'Disable server' : 'Enable server'}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleEnabled(s.name, !s.enabled);
                  }}
                  disabled={!!busy || !!loginName}
                />
              </div>
            );
          })}
        </div>
      )}
      <div className="gutter">
        <button title="Add server" onClick={() => (adding ? nameRef.current?.focus() : setAdding(true))}>
          <Plus size={15} />
        </button>
        <button
          title="Remove selected"
          onClick={() => selected && remove(selected)}
          disabled={!selected || !!busy || !!loginName}
        >
          <Minus size={15} />
        </button>
      </div>

      {loginName && loginUrl?.name === loginName && (
        <p className="muted">
          If the browser didn’t open, authorize here:{' '}
          <a href={loginUrl.url} target="_blank" rel="noreferrer">{loginUrl.url}</a>
        </p>
      )}
      {busy && <p className="muted">{busy}</p>}

      {adding && (
        <>
          <div className="grp-head">Add Server</div>
          <div className="formgroup">
            <div className="seg-ctl">
              <button className={transport === 'http' ? 'active' : ''} onClick={() => setTransport('http')}>
                Remote
              </button>
              <button className={transport === 'stdio' ? 'active' : ''} onClick={() => setTransport('stdio')}>
                Local
              </button>
            </div>
            <input ref={nameRef} className="ifield" placeholder="Name (e.g. fastmail)" value={name} onChange={(e) => setName(e.target.value)} />
            {transport === 'http' ? (
              <>
                <input className="ifield" placeholder="https://api.fastmail.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
                <button
                  className="memory-view-toggle"
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  <ChevronRight size={14} className={showAdvanced ? 'open' : ''} />
                  <strong>Advanced — headers, OAuth client</strong>
                </button>
                {showAdvanced && (
                  <>
                    <textarea
                      className="ifield"
                      placeholder="headers (optional), one per line — e.g. Authorization: Bearer …"
                      rows={2}
                      value={envText}
                      onChange={(e) => setEnvText(e.target.value)}
                    />
                    <div className="grp-head">OAuth sign-in (optional)</div>
                    <input
                      className="ifield"
                      placeholder="OAuth Client ID — for providers without auto-registration (e.g. Slack)"
                      value={oauthClientId}
                      onChange={(e) => setOauthClientId(e.target.value)}
                    />
                    <input
                      className="ifield"
                      type="password"
                      placeholder="OAuth Client Secret (if the provider is a confidential client)"
                      value={oauthClientSecret}
                      onChange={(e) => setOauthClientSecret(e.target.value)}
                    />
                    <input
                      className="ifield"
                      placeholder="OAuth Scopes (space-separated, must match the provider app)"
                      value={oauthScope}
                      onChange={(e) => setOauthScope(e.target.value)}
                    />
                    {oauthClientId.trim() && (
                      <p className="muted">
                        Register this exact redirect URL in the provider app:{' '}
                        <code>http://127.0.0.1:41759/callback</code>
                      </p>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <input className="ifield" placeholder="command (e.g. npx)" value={command} onChange={(e) => setCommand(e.target.value)} />
                <input className="ifield" placeholder="args (space-separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
                <button
                  className="memory-view-toggle"
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  <ChevronRight size={14} className={showAdvanced ? 'open' : ''} />
                  <strong>Advanced — environment variables</strong>
                </button>
                {showAdvanced && (
                  <textarea
                    className="ifield"
                    placeholder="env (optional), one KEY=value per line"
                    rows={2}
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                  />
                )}
              </>
            )}
            <div className="push-row">
              <button className="push" onClick={closeForm} disabled={!!busy}>Cancel</button>
              <button className="push default" onClick={add} disabled={!canAdd}>Add Server</button>
            </div>
            {transport === 'http' && (
              <p className="muted">
                Most remote servers just need a name and URL — add it, then use “Sign in” to authorize
                via OAuth where supported. For a static token, add an <code>Authorization: Bearer …</code>{' '}
                header under Advanced.
              </p>
            )}
            {error && <p className="error">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
