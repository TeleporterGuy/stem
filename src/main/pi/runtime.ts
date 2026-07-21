import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  watch,
  type FSWatcher
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActivityItem,
  BackendEventEnvelope,
  ChatMessage,
  ChatSummary,
  InstructionsProposal,
  McpAdminProposal,
  McpLoginResult,
  McpServerInput,
  MessageAttachment,
  MessageMeta,
  ModelServiceTier,
  ModelSummary,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../../shared/types';
import {
  API_KEY_PROVIDER_IDS,
  AUTH_PROVIDER_IDS,
  LOCAL_PROVIDER_IDS,
  providerName
} from '../../shared/providers';
import { log } from '../log';
import { PLAIN_MD_DIRECTIVE, STEM_ASSISTANT_INSTRUCTIONS } from '../workspace/bootstrap';
import { readSettings } from '../workspace/settings';
import { captureMemoryFromUserInput, isRecallEnabled } from '../workspace/memory';
import { buildRecallContext, type RecallTimings } from '../recall/inject';
import { reconcileExplicitFact } from '../recall/reconcile';
import { buildFilesContext } from '../files/inject';
import { buildConnectedFoldersContext } from '../connected-folders/inject';
import { getPrivateRoots } from '../workspace/connected-folders';
import { resolveAttachments, type PiImageContent } from './attachments';
import { captureUserMessage } from '../recall/capture';
import type { ApprovalId, ChatBackend, TaskBridge } from '../backend/types';
import {
  buildMcpCatalogContext,
  ensureMcpConfig,
  mcpServerAuthIdentity,
  migrateLegacyOAuthTokens,
  piExtensionPath,
  piMcpOAuthPath,
  piMcpStatusPath,
  readMcpConfig,
  saveOAuthTokenIfServerMatches,
  writeNativeSearchGate,
  writeServiceTierGate
} from './mcp-config';
import { authorizeMcp } from './oauth';
import { syncModelsConfig } from './models-config';
import { piMcpConfigPath, skillsRoot } from '../workspace/paths';
import { resolvePi, type PiInvocation } from './locate';
import { PiProcess, type PiEvent } from './rpc';
import {
  newTurnContext,
  normalizePiEvent,
  phaseOfEvents,
  toolCallActivity,
  toTurnUsage,
  type NormalizedEvent,
  type PiUsage,
  type TurnContext,
  type TurnTimingBreakdown
} from './normalize';

import { ForegroundSessionGate } from './session-gate';
import { secretKeyHex } from './secrets';
import {
  ADMIN_APPROVAL_TITLE,
  ENV_MCP_CONFIG,
  ENV_MCP_OAUTH,
  ENV_SECRET_KEY,
  ENV_SKILLS_DIR,
  INSTRUCTIONS_APPROVAL_TITLE,
  parseWebSearchTee,
  SKILLS_REV_FILE,
  TASK_BRIDGE_TITLE,
  toolArgsOf,
  WEB_SEARCH_TEE_KEY
} from './protocol';
import { recallStore, type Fact, type FactTier } from '../recall/store';
const { getTurnActivitiesByThread, getTurnTimingsByThread, upsertTurnActivity, upsertTurnTiming, setActiveFacts, recordTurnInjectedFacts } = recallStore;

// Default provider/model. openai-codex is the user's working ChatGPT subscription
// (verified streaming in the Phase-0 spike); Anthropic/Claude Max is selectable
// but currently gated behind claude.ai "extra usage". gpt-5.3-codex-spark is the
// exact model the spike streamed successfully.
const DEFAULT_PROVIDER = 'openai-codex';
const DEFAULT_MODEL = 'gpt-5.3-codex-spark';

// Providers that serve a native (server-side) web-search tool, which the bridge
// extension injects via before_provider_request. Add 'anthropic' once Claude-via-pi
// is ungated and its injection branch is enabled.
const PROVIDER_NATIVE_SEARCH = new Set(['openai-codex']);
// Friendly provider names for the UI live in shared/providers.ts (also used by
// the renderer's settings/onboarding surfaces).

// Sentinel titles / tee key / gate-file names shared with the bridge extension
// live in ./protocol (with a drift-guard test against the extension source).

// pi has no per-turn context channel, so recall/files/format context is prepended
// into the user's prompt message — which pi then PERSISTS in the session JSONL. To
// keep that injected scaffolding out of the replayed user bubble (it was showing up
// as "a lot of information before the first question" when reopening a Quick Chat
// thread in the main window), wrap it in HTML-comment sentinels and strip it on
// read. The markers are inert to the model and never occur in real user text.
const CONTEXT_OPEN = '<!--stem:context-->';
const CONTEXT_CLOSE = '<!--/stem:context-->';
const CONTEXT_STRIP_RE = /^<!--stem:context-->[\s\S]*?<!--\/stem:context-->\n+/;

// Scheduled-task runs prepend a fenced preamble (model-visible: it tells the agent
// it's running headless and how to surface results) that doubles as a replay marker.
// Like the context fence it's stripped from the rendered user bubble, but it also
// flags the turn as a scheduled run (with its ISO timestamp) so the UI collapses it.
const SCHED_CLOSE = '<!--/stem:scheduled-->';
const SCHED_STRIP_RE = /^<!--stem:scheduled at="([^"]*)"-->[\s\S]*?<!--\/stem:scheduled-->\n+/;

/** The model-visible scheduled-run preamble, fenced for replay stripping + detection. */
function scheduledPreamble(at: string): string {
  return [
    `<!--stem:scheduled at="${at}"-->`,
    'This is an automated scheduled run — no human is reading the reply live. Carry out the task.',
    'If, and only if, the result is something the user should be told about, call the notify_user tool with a short message.',
    'Otherwise just finish quietly. Do not ask the user questions — there is no one to answer.',
    SCHED_CLOSE
  ].join('\n');
}

// Max length for an auto-derived chat title; longer first messages are
// truncated (the sidebar ellipsizes anyway).
const MAX_AUTO_TITLE = 80;

/** Derive a chat title from the first user message: its first non-empty line, trimmed and capped. */
function titleFromInput(input: string): string {
  const line = input.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > MAX_AUTO_TITLE ? `${line.slice(0, MAX_AUTO_TITLE - 1).trimEnd()}…` : line;
}

// Argument keys a built-in file tool (read/grep/find/ls/edit/write) carries its
// target path under. Probed on the raw pi event for the memory-taint check.
const TOOL_PATH_KEYS = ['path', 'file_path', 'filename'] as const;

/** Pull the target file/dir path out of a raw pi tool_execution_start event, if any. */
function readToolPath(ev: PiEvent): string | null {
  const nested = toolArgsOf(ev);
  const probe = (src: Record<string, unknown> | undefined): string | null => {
    if (!src) return null;
    for (const key of TOOL_PATH_KEYS) {
      const v = src[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return null;
  };
  return probe(ev as unknown as Record<string, unknown>) ?? probe(nested);
}

/**
 * Resolve a policy-checked path through symlinks. `realpathSync()` handles an
 * existing target directly; for a not-yet-created write target, walk upward to
 * the nearest existing ancestor, canonicalize that, then append the missing
 * suffix. This keeps aliases from bypassing connected-folder policy while still
 * allowing checks before a new file exists.
 */
function resolvePolicyInput(target: string, cwd: string): string {
  // Match pi's resolveToCwd normalization before applying Stem's policy. Without
  // this, pi would expand `~/…`, `file://…`, or a leading `@` to a protected path
  // while the guard checked an unrelated literal path below the workspace.
  let normalized = target.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized === '~') normalized = homedir();
  else if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // Let the ordinary path resolver handle a malformed URL. pi will reject it
      // too, and the policy check remains deterministic rather than throwing.
    }
  }

  return resolve(cwd, normalized);
}

function canonicalizePolicyAbsolutePath(absolutePath: string): string {
  let candidate = absolutePath;
  // realpath is the cheap/common path for an existing target.
  try {
    return realpathSync(candidate);
  } catch {
    // A write target may not exist yet. Walk each existing component with lstat
    // so a *dangling* symlink is still followed (realpath alone cannot resolve a
    // leaf link whose destination has not been created). Restart after every link
    // to cover chains and relative targets; bound the walk like the OS does.
  }

  for (let symlinks = 0; symlinks < 40; symlinks++) {
    const root = parse(candidate).root;
    const parts = candidate.slice(root.length).split(sep).filter(Boolean);
    let cursor = root;
    let followed = false;
    for (let i = 0; i < parts.length; i++) {
      const next = join(cursor, parts[i]);
      let stat;
      try {
        stat = lstatSync(next);
      } catch {
        return resolve(cursor, ...parts.slice(i));
      }
      if (stat.isSymbolicLink()) {
        const destination = readlinkSync(next);
        candidate = resolve(dirname(next), destination, ...parts.slice(i + 1));
        followed = true;
        break;
      }
      cursor = next;
    }
    if (!followed) return candidate;
  }
  // A symlink cycle cannot lead to a successful write/read. Return the last
  // resolved candidate rather than throwing from an event-policy hook.
  return candidate;
}

export function canonicalPolicyPath(target: string, cwd: string): string {
  return canonicalizePolicyAbsolutePath(resolvePolicyInput(target, cwd));
}

function policyPathExists(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror pi's resolveReadPath fallback order after resolveToCwd. Pi tolerates
 * common macOS filename spelling variants; policy must check the same concrete
 * path or an alias spelled with a straight quote/NFC/ordinary space can resolve
 * into a private root only after Stem has authorized the wrong missing path.
 */
function canonicalPolicyReadPath(target: string, cwd: string): string {
  const resolved = resolvePolicyInput(target, cwd);
  if (policyPathExists(resolved)) return canonicalizePolicyAbsolutePath(resolved);
  const narrowSpace = '\u202F';
  const amPm = resolved.replace(/ (AM|PM)\./gi, `${narrowSpace}$1.`);
  const nfd = resolved.normalize('NFD');
  const curly = resolved.replace(/'/g, '\u2019');
  const nfdCurly = nfd.replace(/'/g, '\u2019');
  for (const candidate of [amPm, nfd, curly, nfdCurly]) {
    if (candidate !== resolved && policyPathExists(candidate)) {
      return canonicalizePolicyAbsolutePath(candidate);
    }
  }
  return canonicalizePolicyAbsolutePath(resolved);
}

/** True when `target` (resolved against cwd if relative) is at/inside any of `roots`. */
export function pathInsideAny(target: string, roots: string[], cwd: string): boolean {
  const abs = canonicalPolicyReadPath(target, cwd);
  return roots.some((root) => {
    const r = canonicalPolicyPath(root, cwd);
    return abs === r || abs.startsWith(r + sep);
  });
}

interface RuntimeOptions {
  piHome: string;
  sessionsDir: string;
  workspaceRoot: string;
  /**
   * Seed auth.json from the user's global ~/.pi/agent on first run (default true).
   * Set false for alternate profiles (--fresh / --profile) so they start genuinely
   * unauthenticated and land in the first-run onboarding wizard.
   */
  seedGlobalAuth?: boolean;
}

interface PiModel {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  /** Context window size in tokens (pi defaults to 128000 when a model omits it). */
  contextWindow?: number;
  /**
   * Per-model thinking-level capability/override map from pi. A key present with a
   * non-null value means that level is supported (pi maps it to the provider value
   * internally); a key mapped to null means that level is NOT available. Levels not
   * mentioned keep the reasoning-model default. Absent/null => defaults only.
   */
  thinkingLevelMap?: Record<string, string | null> | null;
}

// The effort levels the UI can display, lowest→highest. 'off' disables reasoning
// entirely; 'xhigh' is opt-in per model via thinkingLevelMap. (pi also has 'minimal',
// which Stem doesn't surface.)
const DISPLAY_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'] as const;
// Levels every reasoning model is assumed to support unless its thinkingLevelMap opts out.
const BASE_EFFORTS = new Set(['off', 'low', 'medium', 'high']);

/** Resolve which display efforts a model supports from pi's thinkingLevelMap. */
function effortsFor(m: PiModel): string[] {
  if (!m.reasoning) return [];
  const map = m.thinkingLevelMap ?? {};
  return DISPLAY_EFFORTS.filter((lvl) => (lvl in map ? map[lvl] !== null : BASE_EFFORTS.has(lvl)));
}

// openai-codex models accept service_tier:'priority' (1.5× speed); other providers have none.
function serviceTiersFor(m: PiModel): ModelServiceTier[] {
  if (m.provider !== 'openai-codex') return [];
  return [{ id: 'priority', name: 'Fast', description: '1.5× speed, increased usage' }];
}

interface SessionFile {
  id: string;
  path: string;
  name: string | null;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The pi (pi.dev) backend, run in RPC mode as a long-lived subprocess.
 * Normalizes pi's command/event protocol into Stem's canonical backend events
 * and satisfies {@link ChatBackend}.
 *
 * Architectural note: pi RPC holds ONE active session per process. So the
 * foreground process tracks the active thread (switch_session/new_session),
 * and `complete()` uses a separate ephemeral `--no-session` process so recall
 * distillation never clobbers the user's active chat.
 */
export class PiRuntime extends EventEmitter implements ChatBackend {
  private proc: PiProcess | null = null;
  private starting: Promise<void> | null = null;
  private foreground = new ForegroundSessionGate();
  private activeThreadId: string | null = null;
  private mcpStatusWatcher: FSWatcher | null = null;
  private mcpStatusDebounce: NodeJS.Timeout | null = null;
  /**
   * The model of the CURRENTLY active pi session, mirrored so `applyModel` can skip a
   * redundant `set_model` within one session. pi resolves the model per session — a new
   * session resets to the spawn default, switching/forking/rolling back loads that
   * session's own persisted model — so this MUST be invalidated (set null) on every
   * session change, or the next `applyModel` wrongly no-ops and the turn runs on the
   * wrong model (e.g. a vision request silently downgraded to text-only Spark).
   */
  private currentModel: string | null = null;
  /**
   * The thinking level of the CURRENTLY active pi session, mirrored like
   * `currentModel` so `setThinking` can skip the redundant `set_thinking_level`
   * round-trip issued on every turn. Sessions persist their own level, so this
   * follows the exact same invalidation discipline: null on every session change.
   */
  private currentThinking: string | null = null;
  /** sessionId → on-disk session file, learned from get_state / dir scans. */
  private sessionFiles = new Map<string, string>();
  /**
   * path → parsed metadata, keyed so an unchanged file (same mtime) is reused on
   * the next scan instead of being re-read and re-parsed. Reading a whole JSONL
   * file (incl. inlined base64 images) just to extract its title is the dominant
   * list/delete cost, so this keeps repeated `listThreads` refreshes cheap.
   */
  private metaCache = new Map<string, { mtimeMs: number; meta: SessionFile }>();
  /**
   * Sessions pre-created via createThread (e.g. Quick Chat) that haven't had a
   * turn yet, so their first turn still gets an auto-derived title — matching the
   * no-threadId path. Drained on first prompt.
   */
  private unnamedThreads = new Set<string>();
  /**
   * Live-turn turnId (a minted uuid) → pi's 8-hex session entry id of that turn's
   * user message. Populated after each turn so fork/rollback can target the right
   * entry. Reloaded threads already use entry ids as turnIds (identity).
   */
  private turnEntryIds = new Map<string, string>();
  /** The turn currently streaming on the foreground process (one at a time). */
  private currentTurn: TurnContext | null = null;
  /** Pending stem-admin approvals, keyed by the bridge's extension_ui_request id. */
  private adminApprovals = new Set<string>();
  /** Immutable proposal snapshot paired with each pending admin approval. */
  private adminApprovalProposals = new Map<
    string,
    { proposal: McpAdminProposal; process: PiProcess | null }
  >();
  /** Pending custom-instructions approvals, keyed by the bridge's extension_ui_request id. */
  private instructionsApprovals = new Set<string>();
  /** Originating process for each held instructions request. */
  private instructionsApprovalProcesses = new Map<string, PiProcess | null>();
  /** Wired by main to route the assistant's schedule_task/notify_user tools. */
  private taskBridge: TaskBridge | null = null;
  /** Set when an admin add/remove was approved; reloads MCP servers at turn end. */
  private pendingMcpReload = false;
  /** Set when a skill was written this turn (or by the curator); reloads at turn end. */
  private pendingSkillReload = false;
  /** The skills revision marker captured at turn start, to detect in-turn skill writes. */
  private skillsRevAtTurnStart = '';

  // ---- crash-loop breaker ----
  // An exit under RAPID_EXIT_MS counts a strike; SPAWN_STRIKE_LIMIT strikes pause
  // respawns for an escalating cooldown so a broken install can't spawn-crash in a
  // tight loop on every turn attempt. A long-lived process resets the count, and a
  // user-initiated restart() clears the breaker outright.
  private static readonly RAPID_EXIT_MS = 15_000;
  private static readonly SPAWN_STRIKE_LIMIT = 3;
  private static readonly COOLDOWN_BASE_MS = 30_000;
  private static readonly COOLDOWN_MAX_MS = 300_000;
  /** Monotonic spawn counter, so one failed spawn never counts two strikes. */
  private spawnGen = 0;
  private strikedGen = 0;
  private spawnStrikes = 0;
  private cooldownUntil = 0;

  /** complete() spawns a throwaway pi process per call; cap them (queue the rest). */
  private static readonly MAX_COMPLETE_PROCS = 2;
  private completeActive = 0;
  private completeWaiters: Array<() => void> = [];

  constructor(private readonly options: RuntimeOptions) {
    super();
  }

  // ---- lifecycle / auth ----

  async status(): Promise<RuntimeStatus> {
    const base: RuntimeStatus = {
      ok: false,
      backendPath: null,
      backendHome: this.options.piHome,
      workspaceRoot: this.options.workspaceRoot
    };
    const pi = await resolvePi();
    if (!pi) return { ...base, error: 'The pi backend could not be located (bundled copy missing and no system pi).' };
    base.backendPath = pi.displayPath;

    await this.ensurePiHome();
    const providers = [...(await this.authProviders())];
    const authed = providers.length > 0;
    if (!authed) {
      return {
        ...base,
        authenticated: false,
        providers,
        loginCommand: this.loginCommand(pi),
        error: 'Stem is not signed in yet.'
      };
    }
    return { ...base, ok: true, authenticated: true, providers, loginCommand: this.loginCommand(pi) };
  }

  async login(): Promise<RuntimeStatus> {
    // pi has no headless `login` subcommand; auth happens in its TUI (`/login`).
    // We seed the isolated home from the user's existing ~/.pi auth when present;
    // otherwise status() surfaces the copy-pasteable command for the TUI flow.
    await this.ensurePiHome();
    return this.status();
  }

  async restart(): Promise<void> {
    // A deliberate restart is the manual breaker reset: the user (or a config
    // change) asked for a fresh spawn, so it always gets one immediately.
    this.spawnStrikes = 0;
    this.cooldownUntil = 0;
    await this.shutdown();
    await this.ensureStarted();
  }

  async prewarm(): Promise<void> {
    await this.ensureStarted();
  }

  async newConversation(): Promise<void> {
    // no-op: the next startTurn with no threadId starts a fresh session.
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.activeThreadId = null;
    this.currentTurn = null;
    this.foreground.reset();
    if (proc) await proc.dispose();
  }

  // ---- turns ----

  async createThread(model?: string): Promise<string> {
    return this.foreground.run(async () => {
      await this.ensureStarted();
      // Create the session FIRST: newSession resets the active model, so applying the
      // model before it would be undone. Apply after so the pre-created session is on it.
      const id = await this.newSession();
      if (model) await this.applyModel(model);
      this.unnamedThreads.add(id);
      return id;
    });
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const memory = await captureMemoryFromUserInput(input.input);
    if (memory.shouldAcknowledge) {
      if (memory.factId != null) {
        // Reconciliation is deliberately off the acknowledgement path: the fact is
        // durable the moment it's written, so a slow model never delays the reply
        // and a failed one costs only the supersede/conflict links, not the memory.
        setTimeout(() => void reconcileExplicitFact(memory.factId!, this), 0);
      }
      return { handled: true, assistantMessage: "I'll remember that.", rememberedPath: memory.path };
    }

    return this.foreground.run(async () => {
      const startedAt = Date.now();
      await this.ensureStarted();
      const ensureMs = Date.now() - startedAt;

      // First turn of a new chat — either a draft started here (no threadId) or a
      // session pre-created via createThread (Quick Chat) that hasn't been prompted.
      const isNewThread = !input.threadId || this.unnamedThreads.has(input.threadId);
      const threadId = input.threadId ? await this.ensureActive(input.threadId) : await this.newSession();
      if (input.model) await this.applyModel(input.model);
      if (input.effort) await this.setThinking(input.effort);

      const turnId = randomUUID();
      const turn = newTurnContext(threadId, turnId);
      turn.startedAt = startedAt;
      turn.ensureMs = ensureMs;
      turn.recall = {};
      // Folders connected memorize:false: if the assistant reads inside one this turn,
      // we suppress capturing its reply into Recall (see onPiEvent / isCaptureSuppressed).
      turn.privateRoots = await getPrivateRoots().catch(() => []);
      this.currentTurn = turn;
      this.skillsRevAtTurnStart = this.readSkillsRev();
      this.foreground.claimTurn();

      try {
        // Gate native web search for THIS turn (main vs Quick Chat share one process,
        // so the bridge can't tell them apart — we set the gate just before the prompt).
        await writeNativeSearchGate(input.webSearch ?? true).catch(() => undefined);
        await writeServiceTierGate(input.serviceTier ?? null).catch(() => undefined);

        const buildStart = Date.now();
        const { message, images } = await this.buildMessage(input, threadId, turn.recall, turnId);
        turn.buildMs = Date.now() - buildStart;
        // Anchor "send" at the write itself so send→firstToken is independent of how
        // pi acks the prompt command. The pre-first-event wait is attributed to no
        // phase bucket (it's TTFT, not thinking) — see advancePhase.
        turn.promptSentAt = Date.now();
        turn.lastEventAt = turn.promptSentAt;
        const res = await this.proc!.request({
          type: 'prompt',
          message,
          images: images.length ? images : undefined
        });
        if (!res.success) throw new Error(res.error ?? 'pi rejected the prompt.');
      } catch (e) {
        this.finishTurn();
        throw e;
      }

      // Persist a title for a brand-new chat. pi never auto-names sessions, so
      // without this the session_info `name` stays empty and the sidebar reverts
      // to "New chat" the moment the backend lists the thread (on restart, refresh,
      // or a folder move) — replacing the renderer's optimistic first-message title.
      this.unnamedThreads.delete(threadId);
      if (isNewThread) {
        const name = titleFromInput(input.input);
        if (name) await this.proc!.request({ type: 'set_session_name', name }).catch(() => undefined);
      }

      if (isRecallEnabled()) {
        try {
          captureUserMessage({ threadId, turnId, text: input.input, cwd: this.options.workspaceRoot });
        } catch {
          // non-fatal; the live turn is already streaming
        }
      }
      return { threadId, turnId };
    });
  }

  async interruptTurn(turnId: string): Promise<void> {
    // Ignore stale cancellation requests. In particular, the scheduler's timeout
    // cleanup must never abort a newer interactive turn if its original turn has
    // already settled without the scheduler observing the terminal event.
    if (!this.proc || !this.currentTurn || this.currentTurn.turnId !== turnId) return;
    this.currentTurn.aborted = true;
    this.proc.send({ type: 'abort' });
  }

  async listModels(): Promise<ModelSummary[]> {
    await this.maybeRefreshLocalModels();
    await this.ensureStarted();
    const res = await this.proc!.request({ type: 'get_available_models' });
    const models = ((res.data as { models?: PiModel[] } | undefined)?.models ?? []).filter(Boolean);
    const providers = await this.authProviders();
    const visible = providers.size ? models.filter((m) => providers.has(m.provider)) : models;
    const def = await this.resolveDefaultModel();
    return visible.map((m) => {
      const id = `${m.provider}/${m.id}`;
      const efforts = effortsFor(m);
      return {
        id,
        displayName: m.name ?? m.id,
        description: m.provider,
        provider: m.provider,
        providerName: providerName(m.provider),
        supportsNativeWebSearch: PROVIDER_NATIVE_SEARCH.has(m.provider),
        supportedEfforts: efforts,
        defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0] ?? 'medium',
        serviceTiers: serviceTiersFor(m),
        isDefault: m.provider === def.provider && m.id === def.modelId,
        ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {})
      };
    });
  }

  isInternalThread(_threadId: string): boolean {
    // complete() runs in a separate ephemeral process, so the foreground stream
    // never carries internal threads — nothing to suppress.
    return false;
  }

  /**
   * True when the active turn read inside a memorize:false connected folder, so its
   * assistant reply must be kept out of Recall. The `item/completed` agentMessage is
   * emitted before agent_end clears currentTurn, so the flag is still live at capture.
   */
  isCaptureSuppressed(threadId: string): boolean {
    return this.currentTurn?.threadId === threadId && this.currentTurn.memoryTainted === true;
  }

  /**
   * One-shot prompt → completion in a throwaway `--no-session` pi process. Backs
   * the LlmClient seam (Stem Recall distillation); isolated from the user's
   * active chat so it can't clobber the foreground session.
   */
  async complete(prompt: string, opts?: { model?: string | null; timeoutMs?: number }): Promise<string> {
    // Every call spawns its own pi process; a burst (distill + consolidation +
    // summary backfill + scheduled runs) must queue instead of forking a pile of
    // concurrent children.
    await this.acquireCompleteSlot();
    try {
      return await this.completeNow(prompt, opts);
    } finally {
      this.releaseCompleteSlot();
    }
  }

  private acquireCompleteSlot(): Promise<void> {
    if (this.completeActive < PiRuntime.MAX_COMPLETE_PROCS) {
      this.completeActive += 1;
      return Promise.resolve();
    }
    // The slot is handed over directly in releaseCompleteSlot, so completeActive
    // stays constant across the transfer.
    return new Promise((resolve) => this.completeWaiters.push(resolve));
  }

  private releaseCompleteSlot(): void {
    const next = this.completeWaiters.shift();
    if (next) next();
    else this.completeActive -= 1;
  }

  private async completeNow(prompt: string, opts?: { model?: string | null; timeoutMs?: number }): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const pi = await resolvePi();
    if (!pi) throw new Error('The pi backend could not be located.');
    await this.ensurePiHome();
    // Memory distillation/consolidation can run on a user-configured model
    // (Manage → Memory); fall back to the backend default when unset.
    const { provider, modelId } = opts?.model
      ? this.parseModel(opts.model)
      : await this.resolveDefaultModel();
    const child = new PiProcess({
      command: pi.command,
      prefixArgs: pi.prefixArgs,
      cwd: join(this.options.workspaceRoot, '.stem-internal'),
      env: this.sanitizedEnv(pi),
      args: [
        '--no-session',
        '--no-builtin-tools',
        '--no-skills',
        '--provider',
        provider,
        '--model',
        modelId,
        '--system-prompt',
        'You are a precise extraction engine. Follow the instructions exactly and output only what is requested.'
      ]
    });

    let text = '';
    const done = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        log('pi.complete', 'one-shot completion timed out', { timeoutMs, provider, model: modelId });
        reject(new Error('pi completion timed out.'));
      }, timeoutMs);
      const onEvent = (ev: PiEvent): void => {
        if (ev.type === 'message_end') {
          const msg = ev.message as { role?: string; content?: { type?: string; text?: string }[] } | undefined;
          if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
            const t = msg.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
            if (t) text = t;
          }
        } else if (ev.type === 'agent_end') {
          cleanup();
          resolve(text);
        }
      };
      const onExit = (): void => {
        cleanup();
        resolve(text);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off('event', onEvent);
        child.off('exit', onExit);
      };
      child.on('event', onEvent);
      child.on('exit', onExit);
    });

    try {
      child.start();
      child.send({ type: 'prompt', message: prompt });
      return await done;
    } finally {
      void child.dispose().catch(() => {});
    }
  }

  // ---- thread CRUD ----

  async listThreads(): Promise<ChatSummary[]> {
    // The pi session dir is Stem-owned and isolated (PI_CODING_AGENT_SESSION_DIR),
    // so every session in it is ours — no cwd filtering needed (and cwd is stored
    // as a realpath, which would make an equality filter brittle anyway).
    const files = await this.scanSessions();
    return files
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((f) => ({
        threadId: f.id,
        title: (f.name || 'New chat').trim() || 'New chat',
        folderId: null,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt
      }));
  }

  async readThread(threadId: string): Promise<{ title: string; messages: ChatMessage[] }> {
    const file = await this.resolveSessionFile(threadId);
    if (!file) {
      // No persisted file yet (a freshly forked/created session writes lazily on
      // first append). If it's the live active session, read its in-memory state.
      if (this.proc?.running && this.activeThreadId === threadId) return this.readActiveMessages();
      return { title: 'New chat', messages: [] };
    }
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return { title: 'New chat', messages: [] };
    }
    let title = 'New chat';
    const messages: ChatMessage[] = [];
    let lastUserId = '';
    // Persisted answer-time breakdowns + tool activity, keyed by the final
    // assistant entry id.
    const timings = getTurnTimingsByThread(threadId);
    const activities = getTurnActivitiesByThread(threadId);
    // Fallback for turns predating the sqlite activity rows: synthesize activity
    // items from the session's own persisted toolCall blocks + toolResult entries.
    let pendingActivity: ActivityItem[] = [];
    // Which model/effort produced each reply (the hover label next to "Stem").
    // Assistant entries persist provider+model directly; effort comes from the
    // thinking_level_change entry in force when the reply was written, and
    // model_change covers assistant entries predating the per-message fields.
    // Service tier is not persisted (same as the old codex rollout format).
    let effortNow: string | undefined;
    let modelNow: string | undefined;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: {
        type?: string;
        id?: string;
        name?: string;
        timestamp?: string;
        provider?: string;
        modelId?: string;
        thinkingLevel?: string;
        message?: {
          role?: string;
          content?: unknown;
          usage?: PiUsage;
          toolCallId?: string;
          isError?: boolean;
          provider?: string;
          model?: string;
        };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === 'session_info' && typeof entry.name === 'string') {
        title = entry.name.trim() || title;
        continue;
      }
      if (entry.type === 'model_change' && entry.provider && entry.modelId) {
        modelNow = `${entry.provider}/${entry.modelId}`;
        continue;
      }
      if (entry.type === 'thinking_level_change' && entry.thinkingLevel) {
        effortNow = entry.thinkingLevel;
        continue;
      }
      if (entry.type !== 'message' || !entry.message) continue;
      const role = entry.message.role;
      if (role === 'toolResult') {
        const hit = pendingActivity.find((a) => a.id === entry.message?.toolCallId);
        if (hit && entry.message.isError === true) hit.status = 'error';
        continue;
      }
      const { text: content, images, scheduled } = this.contentToParts(entry.message.content);
      if (role === 'user') {
        lastUserId = entry.id ?? lastUserId;
        pendingActivity = [];
        if (content.trim() || images.length)
          messages.push({
            id: `user-${entry.id}`,
            role: 'user',
            content,
            turnId: entry.id,
            ...(entry.timestamp ? { createdAt: entry.timestamp } : {}),
            ...(images.length ? { attachments: images } : {}),
            ...(scheduled ? { scheduled } : {})
          });
      } else if (role === 'assistant') {
        if (Array.isArray(entry.message.content)) {
          for (const block of entry.message.content as Array<Record<string, unknown>>) {
            if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue;
            if (pendingActivity.some((a) => a.id === block.id)) continue;
            const item = toolCallActivity(
              block.id,
              typeof block.name === 'string' ? block.name : undefined,
              block.arguments as Record<string, unknown> | undefined
            );
            // History has no live spinner — assume ok until a toolResult says error.
            item.status = 'ok';
            pendingActivity.push(item);
          }
        }
        if (content.trim()) {
          const timing = entry.id ? timings.get(entry.id) : undefined;
          const usage = toTurnUsage(entry.message.usage);
          const persisted = entry.id ? activities.get(entry.id) : undefined;
          const activity = persisted?.activity?.length
            ? persisted.activity
            : pendingActivity.length
              ? [...pendingActivity]
              : undefined;
          const sources = persisted?.sources?.length ? persisted.sources : undefined;
          const model =
            entry.message.provider && entry.message.model
              ? `${entry.message.provider}/${entry.message.model}`
              : modelNow;
          const meta: MessageMeta | undefined =
            model || effortNow
              ? { ...(model ? { model } : {}), ...(effortNow ? { effort: effortNow } : {}) }
              : undefined;
          messages.push({
            id: `assistant-${entry.id}`,
            role: 'assistant',
            content,
            turnId: lastUserId || entry.id,
            ...(meta ? { meta } : {}),
            ...(timing ? { timing } : {}),
            ...(usage ? { usage } : {}),
            ...(activity ? { activity } : {}),
            ...(sources ? { sources } : {})
          });
        }
      }
    }
    return { title, messages };
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.foreground.run(async () => {
      await this.ensureStarted();
      await this.ensureActive(threadId);
    });
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.foreground.run(async () => {
      await this.ensureStarted();
      await this.ensureActive(threadId);
      const renamed = await this.proc!.request({ type: 'set_session_name', name });
      if (!renamed.success) throw new Error(renamed.error ?? `pi could not rename chat "${threadId}".`);
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    // If the thread being deleted is mid-stream, abort its turn first: the gated
    // body below waits on activeTurnDone, so without this the unlink/new_session
    // would stall until the whole LLM turn finishes. pi emits `done` on abort,
    // which resolves the gate and lets the delete proceed promptly.
    if (this.activeThreadId === threadId && this.currentTurn) {
      await this.interruptTurn(this.currentTurn.turnId);
    }
    await this.foreground.run(async () => {
      const file = await this.resolveSessionFile(threadId);
      if (this.activeThreadId === threadId) {
        if (this.proc) {
          const parked = await this.proc.request({ type: 'new_session' });
          if (!parked.success) throw new Error(parked.error ?? 'pi could not leave the chat before deleting it.');
          // A successful new_session resets all active-session mirrors.
          this.currentModel = null;
          this.currentThinking = null;
        }
        this.activeThreadId = null;
      }
      this.sessionFiles.delete(threadId);
      this.unnamedThreads.delete(threadId);
      if (file) await unlink(file).catch(() => undefined);
    });
  }

  /**
   * In-place retry/edit: drop the chosen turn and everything after it, keeping the
   * SAME thread id. pi has no rollback RPC, but its sessions are append-only JSONL
   * trees — so we park the process off the file, truncate it at the turn's entry,
   * and `switch_session` back to force a reload at the trimmed leaf (verified
   * id-stable). The renderer then re-sends the prompt as a fresh turn.
   */
  async rollbackToTurn(threadId: string, turnId: string): Promise<void> {
    await this.foreground.run(async () => {
      await this.ensureStarted();
      const file = await this.resolveSessionFile(threadId);
      if (!file) throw new Error('This chat has no saved history to edit yet.');
      const entryId = this.resolveEntryId(turnId);
      const raw = await readFile(file, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      const idx = lines.findIndex((l) => this.entryIdOf(l) === entryId);
      if (idx <= 0) throw new Error('Could not locate that message to edit. Reopen the chat and try again.');
      // Park the foreground off this file so the reload reads our truncated copy.
      const parked = await this.proc!.request({ type: 'new_session' });
      if (!parked.success) throw new Error(parked.error ?? 'pi could not park the active chat for editing.');
      // The backend is now on a fresh parking session. Clear mirrors immediately;
      // if truncation/reload fails, never claim that it is still on either chat.
      this.currentModel = null;
      this.currentThinking = null;
      this.activeThreadId = null;
      await writeFile(file, lines.slice(0, idx).join('\n') + '\n');
      const switched = await this.proc!.request({ type: 'switch_session', sessionPath: file });
      if (!switched.success) throw new Error(switched.error ?? `pi could not reload chat "${threadId}" after editing.`);
      // Both RPCs above swap the active session's model/thinking out from under us.
      this.currentModel = null;
      this.currentThinking = null;
      this.activeThreadId = threadId;
    });
  }

  /**
   * Branch the conversation into a NEW chat via pi's native `fork`. Forking from
   * the next user message keeps everything up to and including the chosen turn;
   * for the last turn, fork at it (re-ask). Returns the new session id; the new
   * session is active and read live until its file is written on first append.
   */
  async forkThread(threadId: string, turnId: string): Promise<{ threadId: string }> {
    return this.foreground.run(async () => {
      await this.ensureStarted();
      await this.ensureActive(threadId);
      const entryId = this.resolveEntryId(turnId);
      const fm = await this.proc!.request({ type: 'get_fork_messages' });
      const entries = (fm.data as { messages?: { entryId: string }[] } | undefined)?.messages ?? [];
      const i = entries.findIndex((e) => e.entryId === entryId);
      if (i === -1) throw new Error('Reopen this chat to fork from an earlier message.');
      const forkEntry = entries[i + 1]?.entryId ?? entries[i].entryId;
      const res = await this.proc!.request({ type: 'fork', entryId: forkEntry });
      if (!res.success) throw new Error(res.error ?? 'pi could not fork this chat.');
      const state = await this.proc!.request({ type: 'get_state' });
      const newId = this.recordState(state.data);
      if (!newId) throw new Error('pi did not return a forked session id.');
      // The fork becomes the active session — invalidate the model/thinking mirrors.
      this.currentModel = null;
      this.currentThinking = null;
      this.activeThreadId = newId;
      return { threadId: newId };
    });
  }

  // ---- MCP (Phase 3) ----

  /**
   * OAuth browser sign-in for a remote (http) MCP server that requires it
   * (e.g. Fastmail). Discovers the authorization server, dynamically registers a
   * public client, runs the PKCE authorization-code flow against a loopback
   * redirect, and persists the resulting token. The renderer respawns pi after
   * `ok` (reconnect → restart), so the bridge picks up the token and connects.
   */
  async mcpLogin(name: string): Promise<McpLoginResult> {
    // Defense-in-depth: names are validated on add, but this value is keyed into
    // a token file and used to look up a URL — guard here too.
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('-')) {
      return { ok: false, error: 'Invalid MCP server name.' };
    }
    try {
      const config = await readMcpConfig();
      const server = config.servers[name];
      if (!server) return { ok: false, error: `No MCP server named "${name}".` };
      if (!server.url) return { ok: false, error: 'Only remote (http) servers use OAuth sign-in.' };
      const authIdentity = mcpServerAuthIdentity(server)!;
      const token = await authorizeMcp(server.url, {
        onAuthUrl: (url) => this.emitEvent('mcp/login/url', { name, url }),
        // Static confidential-client credentials, when the server was configured
        // with them (providers without dynamic client registration, e.g. Slack).
        clientId: server.oauthClientId,
        clientSecret: server.oauthClientSecret,
        scope: server.oauthScope
      });
      // The browser flow can take minutes. Check and persist under the same
      // cross-process state lock used by server replacement/removal, so a login
      // can neither land on a new identity nor be deleted by a stale snapshot.
      if (!(await saveOAuthTokenIfServerMatches(name, authIdentity, token))) {
        return { ok: false, error: `MCP server "${name}" changed during sign-in. Start sign-in again.` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Push live MCP connection status to the renderer (`mcp/status`). The bridge
   * connects routed servers in the BACKGROUND (pi readiness no longer waits for
   * them) and rewrites mcp-status.json as each settles, so an open Manage panel
   * must hear about starting→ready/failed transitions landing after startup.
   */
  private ensureMcpStatusWatcher(): void {
    if (this.mcpStatusWatcher) return;
    try {
      // Watch the directory, not the file: the bridge may recreate the file, and a
      // directory watch survives inode replacement.
      this.mcpStatusWatcher = watch(this.options.piHome, (_event, filename) => {
        if (filename !== 'mcp-status.json') return;
        if (this.mcpStatusDebounce) clearTimeout(this.mcpStatusDebounce);
        this.mcpStatusDebounce = setTimeout(() => {
          this.mcpStatusDebounce = null;
          this.emitEvent('mcp/status', this.getMcpStatus());
        }, 50);
      });
    } catch {
      // best-effort: the panel still fetches on open
    }
  }

  getMcpStatus(): Record<string, { status: string; error: string | null }> {
    // The bridge extension writes live connection status next to mcp.json.
    try {
      const parsed = JSON.parse(readFileSync(piMcpStatusPath(), 'utf8')) as Record<
        string,
        { status?: string; error?: string | null }
      >;
      const out: Record<string, { status: string; error: string | null }> = {};
      for (const [name, s] of Object.entries(parsed)) {
        out[name] = { status: s.status ?? 'unknown', error: s.error ?? null };
      }
      return out;
    } catch {
      return {};
    }
  }

  async resolveAdminApproval(
    id: ApprovalId,
    accept: boolean,
    beforeAccept?: (proposal: McpAdminProposal) => Promise<void>
  ): Promise<boolean> {
    const key = String(id);
    const pending = this.adminApprovalProposals.get(key);
    // Claim the id before awaiting the config write. This keeps an expired or
    // double-clicked card from mutating config, and makes the timeout harmless
    // while the accepted write is in flight.
    if (!pending || !this.adminApprovals.delete(key)) return false;
    this.adminApprovalProposals.delete(key);
    try {
      if (accept && beforeAccept) await beforeAccept(pending.proposal);
      pending.process?.send({ type: 'extension_ui_response', id: key, confirmed: accept });
      if (accept) {
        this.pendingMcpReload = true;
        // A concurrent process exit/restart can settle the originating turn while
        // main writes config. If idle now, reload immediately; otherwise the
        // current turn's normal finish barrier will apply it safely.
        if (!this.currentTurn) {
          this.pendingMcpReload = false;
          void this.configMcpServerReload().catch(() => undefined);
        }
      }
      this.emitEvent('mcp/admin/approvalResolved', { id: key });
      return true;
    } catch (error) {
      pending.process?.send({ type: 'extension_ui_response', id: key, confirmed: false });
      this.emitEvent('mcp/admin/approvalResolved', { id: key });
      throw error;
    }
  }

  /**
   * Release a held custom-instructions approval. Unlike the admin path, MAIN has
   * already written settings.json (the IPC handler does it before calling this), so
   * there's nothing to reload — the next turn reads the instructions fresh.
   */
  async resolveInstructionsApproval(
    id: ApprovalId,
    accept: boolean,
    beforeAccept?: () => Promise<void>
  ): Promise<boolean> {
    const key = String(id);
    const requestProcess = this.instructionsApprovalProcesses.get(key);
    // Claim the id before awaiting the settings write. This is the final
    // authorization boundary: a proposal that already expired cannot mutate
    // settings, and its timeout cannot race the accepted write.
    if (!this.instructionsApprovals.delete(key)) return false;
    this.instructionsApprovalProcesses.delete(key);
    try {
      if (accept && beforeAccept) await beforeAccept();
      requestProcess?.send({ type: 'extension_ui_response', id: key, confirmed: accept });
      this.emitEvent('instructions/approvalResolved', { id: key });
      return true;
    } catch (error) {
      requestProcess?.send({ type: 'extension_ui_response', id: key, confirmed: false });
      this.emitEvent('instructions/approvalResolved', { id: key });
      throw error;
    }
  }

  private settleAdminApproval(id: string): boolean {
    if (!this.adminApprovals.delete(id)) return false;
    this.adminApprovalProposals.delete(id);
    this.emitEvent('mcp/admin/approvalResolved', { id });
    return true;
  }

  private settleInstructionsApproval(id: string): boolean {
    if (!this.instructionsApprovals.delete(id)) return false;
    this.instructionsApprovalProcesses.delete(id);
    this.emitEvent('instructions/approvalResolved', { id });
    return true;
  }

  private settleAllApprovals(): void {
    for (const id of [...this.adminApprovals]) this.settleAdminApproval(id);
    for (const id of [...this.instructionsApprovals]) this.settleInstructionsApproval(id);
  }

  private async configMcpServerReload(): Promise<void> {
    // A reload is a full pi restart. Pay the cold-start cost HERE (spawn + MCP
    // connect + re-activating the previous thread/model) instead of lazily on the
    // next user turn — a user turn queued behind this gate then starts warm.
    const prevThread = this.activeThreadId;
    const prevModel = this.currentModel;
    await this.shutdown();
    await this.foreground.run(async () => {
      await this.ensureStarted();
      try {
        if (prevThread) await this.ensureActive(prevThread);
        if (prevModel) await this.applyModel(prevModel);
      } catch {
        // Best-effort warm-up; the next turn re-establishes state on the normal path.
      }
    });
  }

  setTaskBridge(bridge: TaskBridge | null): void {
    this.taskBridge = bridge;
  }

  /**
   * Handle a scheduled-task tool's ctx.ui.input round-trip (sentinel TASK_BRIDGE_TITLE).
   * The placeholder is a JSON op payload; we run it against the wired TaskBridge using
   * the CURRENT turn's threadId (the only authoritative source — the extension can't
   * know Stem's thread id) and answer with a JSON result string the tool returns.
   */
  private handleTaskBridgeRequest(id: string, payload: string | undefined): void {
    const respond = (value: unknown): void =>
      this.proc?.send({ type: 'extension_ui_response', id, value: JSON.stringify(value) });
    const threadId = this.currentTurn?.threadId;
    void (async () => {
      try {
        const bridge = this.taskBridge;
        if (!bridge) return respond({ ok: false, error: 'Scheduled tasks are unavailable.' });
        if (!threadId) return respond({ ok: false, error: 'No active conversation to attach the task to.' });
        const req = JSON.parse(payload ?? '{}') as {
          op?: string;
          prompt?: string;
          cron?: string;
          at?: string;
          taskId?: string;
          title?: string;
          message?: string;
        };
        switch (req.op) {
          case 'schedule': {
            const res = await bridge.schedule({ prompt: req.prompt ?? '', cron: req.cron, at: req.at }, threadId);
            return respond(res);
          }
          case 'list': {
            const tasks = await bridge.listForThread(threadId);
            return respond({ ok: true, tasks });
          }
          case 'cancel': {
            const res = await bridge.cancel(req.taskId ?? '');
            return respond(res);
          }
          case 'notify': {
            await bridge.notify({ title: req.title, message: req.message ?? '' }, threadId);
            return respond({ ok: true });
          }
          default:
            return respond({ ok: false, error: `Unknown task op "${req.op}".` });
        }
      } catch (e) {
        respond({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }

  // ---- internals ----

  private emitEvent(method: string, params?: unknown): void {
    const event: BackendEventEnvelope = { method, params, receivedAt: new Date().toISOString() };
    this.emit('event', event);
  }

  private ensureStarted(): Promise<void> {
    if (this.proc && this.proc.running) return Promise.resolve();
    if (this.starting) return this.starting;
    const cooldownLeft = this.cooldownUntil - Date.now();
    if (cooldownLeft > 0) {
      return Promise.reject(new Error(
        `The pi backend keeps exiting right after startup; waiting ${Math.ceil(cooldownLeft / 1000)}s before ` +
        `trying again. Restarting the backend from Settings retries immediately.`
      ));
    }
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Crash-loop accounting for one spawn generation (deduped: an exit event and a
   * failed startup probe for the same spawn count once). Rapid exits accumulate
   * strikes toward a cooldown; a process that lived a while resets them.
   */
  private noteProcessExit(gen: number, uptimeMs: number): void {
    if (this.strikedGen === gen) return;
    this.strikedGen = gen;
    if (uptimeMs >= PiRuntime.RAPID_EXIT_MS) {
      this.spawnStrikes = 0;
      return;
    }
    this.spawnStrikes += 1;
    if (this.spawnStrikes >= PiRuntime.SPAWN_STRIKE_LIMIT) {
      const backoffMs = Math.min(
        PiRuntime.COOLDOWN_MAX_MS,
        PiRuntime.COOLDOWN_BASE_MS * 2 ** (this.spawnStrikes - PiRuntime.SPAWN_STRIKE_LIMIT)
      );
      this.cooldownUntil = Date.now() + backoffMs;
      log('pi', `crash loop: ${this.spawnStrikes} rapid exits, pausing respawns`, { backoffMs });
      this.emitEvent('process/cooldown', { until: this.cooldownUntil, strikes: this.spawnStrikes });
    }
  }

  private async start(): Promise<void> {
    const pi = await resolvePi();
    if (!pi) throw new Error('The pi backend could not be located.');
    await this.ensurePiHome();
    this.ensureMcpStatusWatcher();
    // Refresh the local-provider catalog (models.json) before the spawn: pi's RPC
    // mode reads the file once at startup and never again.
    this.lastLocalSyncAt = Date.now();
    await syncModelsConfig().catch(() => undefined);
    const { provider, modelId } = await this.resolveDefaultModel();

    const proc = new PiProcess({
      command: pi.command,
      prefixArgs: pi.prefixArgs,
      cwd: this.options.workspaceRoot,
      env: this.sanitizedEnv(pi),
      args: [
        // Filesystem access: keep pi's read/edit/write built-ins (so the assistant can
        // open AND create/modify files in the Files folder). Exclude only `bash`
        // (arbitrary shell — a much larger surface, not needed for a chat assistant).
        // `--exclude-tools` (a denylist) is deliberate over a `--tools` allowlist: pi's
        // allowlist gates EXTENSION/custom tools too (verified in pi's agent-session.js
        // isAllowedTool), so `--tools` would silently drop stem-recall, the MCP router,
        // web_search, and the skills/admin tools. The browse tools grep/find/ls (which
        // pi leaves OFF by default, needed to explore connected folders) are instead
        // turned on at session_start via pi.setActiveTools in the bridge extension —
        // they stay registered under the denylist, just inactive until activated.
        '--exclude-tools',
        'bash',
        '-e',
        piExtensionPath(),
        '--provider',
        provider,
        '--model',
        modelId,
        '--append-system-prompt',
        STEM_ASSISTANT_INSTRUCTIONS
      ]
    });
    this.proc = proc;
    this.currentModel = `${provider}/${modelId}`;
    // A fresh process starts a fresh session whose thinking level is unknown to us.
    this.currentThinking = null;
    const gen = ++this.spawnGen;
    const spawnedAt = Date.now();
    log('pi', 'spawning backend', { provider, model: modelId, gen });

    proc.on('event', (ev: PiEvent) => this.onPiEvent(ev));
    proc.on('stderr', (text: string) => {
      this.emitEvent('process/stderr', { text });
      log('pi.stderr', text.trim());
    });
    proc.on('exit', (info: { code: number | null; signal: string | null }) => {
      // shutdown()/restart() detach the process before disposing it — only an
      // exit of the CURRENT process is unexpected and feeds the breaker.
      const unexpected = this.proc === proc;
      this.proc = null;
      this.activeThreadId = null;
      this.currentTurn = null;
      this.settleAllApprovals();
      this.foreground.finishTurn();
      this.emitEvent('process/exit', info);
      const uptimeMs = Date.now() - spawnedAt;
      log('pi', unexpected ? 'backend exited unexpectedly' : 'backend stopped', { ...info, uptimeMs, gen });
      if (unexpected) this.noteProcessExit(gen, uptimeMs);
    });

    try {
      proc.start();
      // Probe readiness and capture the initial session id/file.
      const state = await proc.request({ type: 'get_state' }, 20_000);
      this.recordState(state.data);
    } catch (e) {
      // A spawn that never became ready must not linger half-alive: detach it so
      // ensureStarted() doesn't mistake it for a running backend, and count it
      // toward the crash-loop breaker (deduped with the exit handler above).
      if (this.proc === proc) this.proc = null;
      void proc.dispose().catch(() => undefined);
      log('pi', 'backend failed to become ready', { error: e instanceof Error ? e.message : String(e), gen });
      this.noteProcessExit(gen, Date.now() - spawnedAt);
      throw e;
    }
  }

  private onPiEvent(ev: PiEvent): void {
    if (ev.type === 'extension_ui_request') {
      const id = ev.id as string;
      // The bridge's web-search tee (fire-and-forget notify; no response needed).
      if (ev.method === 'notify') {
        const msg = ev.message as string | undefined;
        if (typeof msg === 'string' && msg.includes(WEB_SEARCH_TEE_KEY)) this.handleWebSearchTee(msg);
        return;
      }
      // The bridge's MCP add/remove approval → route to Stem's McpApprovalCard.
      if (ev.method === 'confirm' && ev.title === ADMIN_APPROVAL_TITLE) {
        this.handleAdminApproval(id, ev.message as string | undefined);
        return;
      }
      // The bridge's custom-instructions approval → route to the InstructionsApprovalCard.
      if (ev.method === 'confirm' && ev.title === INSTRUCTIONS_APPROVAL_TITLE) {
        this.handleInstructionsApproval(id, ev.message as string | undefined);
        return;
      }
      // A scheduled-task tool round-trip (schedule_task / notify_user / …). The op
      // payload rides in `placeholder` (ctx.ui.input's second arg); we never show UI.
      if (ev.method === 'input' && ev.title === TASK_BRIDGE_TITLE) {
        this.handleTaskBridgeRequest(id, ev.placeholder as string | undefined);
        return;
      }
      // No UI for other dialogs yet — dismiss them safely.
      if (ev.method === 'confirm') this.proc?.send({ type: 'extension_ui_response', id, confirmed: false });
      else if (ev.method === 'select' || ev.method === 'input' || ev.method === 'editor')
        this.proc?.send({ type: 'extension_ui_response', id, cancelled: true });
      return;
    }
    if (!this.currentTurn) return;
    const turn = this.currentTurn;
    // Memory privacy: if this turn reads inside a memorize:false connected folder,
    // taint it so its assistant reply never enters Recall. Checked on the RAW event
    // (the normalizer truncates the path to a basename, losing the dir for matching).
    if (!turn.memoryTainted && turn.privateRoots?.length && ev.type === 'tool_execution_start') {
      const p = readToolPath(ev);
      if (p && pathInsideAny(p, turn.privateRoots, this.options.workspaceRoot)) turn.memoryTainted = true;
    }
    const { events, done } = normalizePiEvent(ev, turn);
    const now = Date.now();
    if (events.length) {
      if (turn.firstActivityAt === undefined) turn.firstActivityAt = now;
      if (turn.firstTokenAt === undefined && events.some((e) => e.method === 'item/agentMessage/delta')) {
        turn.firstTokenAt = now;
      }
      this.advancePhase(turn, events, now);
    }
    for (const e of events) this.emitEvent(e.method, e.params);
    if (done) {
      turn.endedAt = now;
      this.advancePhase(turn, [], now); // flush the trailing segment
      this.reportTurnTiming(turn);
      // Web sources recovered by the tee ride out at turn end (the assistant
      // bubble exists by now, so the renderer can attach them).
      if (turn.sources.length) {
        this.emitEvent('turn/sources', { threadId: turn.threadId, turnId: turn.turnId, sources: turn.sources });
      }
      // The assistant may have created/patched a skill via manage_skill this turn;
      // detect it (the bridge bumps the rev marker) and reload at turn end.
      if (this.readSkillsRev() !== this.skillsRevAtTurnStart) {
        this.pendingSkillReload = true;
        this.emitEvent('skills/changed');
      }
      this.finishTurn();
      // Map this live turn's minted id to its persisted entry id so a later
      // fork/edit targets the right pi entry — and persist the turn's timing.
      void this.recordTurnEntry(turn);
    }
  }

  /**
   * A web-search event recovered by the bridge's provider-stream tee (native
   * search runs server-side, so pi emits nothing for it — see the extension).
   * Mapped onto the same item/started + item/completed events a function tool
   * produces, so activity rows, the HUD label, and persistence all just work.
   */
  private handleWebSearchTee(message: string): void {
    const turn = this.currentTurn;
    if (!turn) return; // a tee event with no live turn — drop
    const payload = parseWebSearchTee(message);
    if (!payload) return;
    const { threadId, turnId } = turn;
    if (payload.phase === 'source') {
      const url = payload.url;
      if (typeof url === 'string' && !turn.sources.some((s) => s.url === url)) {
        turn.sources.push({ url, ...(payload.title ? { title: payload.title } : {}) });
      }
      return;
    }
    const id = payload.id ?? `websearch-${turn.activity.length}`;
    if (payload.phase === 'started') {
      if (!turn.activity.some((a) => a.id === id)) {
        turn.activity.push({
          id,
          kind: 'webSearch',
          type: 'webSearch',
          name: 'web_search',
          detail: payload.query,
          status: 'running'
        });
      }
      this.emitEvent('item/started', {
        item: { type: 'webSearch', id, name: 'web_search', detail: payload.query },
        threadId,
        turnId
      });
    } else if (payload.phase === 'completed') {
      const entry = turn.activity.find((a) => a.id === id);
      if (!entry) return;
      entry.status = payload.status === 'failed' ? 'error' : 'ok';
      if (payload.query) entry.detail = payload.query; // the query often only fills in at done
      this.emitEvent('item/completed', {
        item: { type: 'webSearch', id, name: 'web_search', detail: entry.detail, status: entry.status },
        threadId,
        turnId
      });
    }
  }

  /**
   * Attribute the interval since the last event to the phase that was active, then
   * switch to the phase the new events represent. The first interval (promptSent →
   * first event) is skipped because phase starts 'pending' — that wait is TTFT, not
   * thinking. Approximate: a tool's idle gap until the next event counts as tool time.
   */
  private advancePhase(turn: TurnContext, events: NormalizedEvent[], now: number): void {
    if (turn.phase !== 'pending' && turn.lastEventAt !== undefined) {
      const dt = now - turn.lastEventAt;
      if (turn.phase === 'thinking') turn.thinkingMs += dt;
      else if (turn.phase === 'tool') turn.toolMs += dt;
      else if (turn.phase === 'answer') turn.answerMs += dt;
    }
    const next = phaseOfEvents(events);
    if (next) turn.phase = next;
    turn.lastEventAt = now;
  }

  /**
   * Log a one-line latency breakdown for a finished turn and emit it as a
   * `turn/timing` event. Splits the wall time into pre-send work (build/recall,
   * which is dead time the user waits through before any response) vs. the model's
   * own time-to-first-token and generation, so a slow turn can be attributed.
   */
  private reportTurnTiming(turn: TurnContext): void {
    const { startedAt, promptSentAt, firstActivityAt, firstTokenAt, endedAt } = turn;
    if (startedAt === undefined || endedAt === undefined) return;
    const ms = (a?: number, b?: number): number | null =>
      a === undefined || b === undefined ? null : Math.round(b - a);
    const r = turn.recall ?? {};
    const breakdown: TurnTimingBreakdown = {
      threadId: turn.threadId,
      turnId: turn.turnId,
      ensureMs: turn.ensureMs ?? 0,
      buildMs: turn.buildMs ?? null,
      recall: {
        total: r.total ?? null,
        facts: r.facts ?? null,
        embed: r.embed ?? null,
        rerank: r.rerank ?? null,
        search: r.search ?? null
      },
      thinkingMs: turn.thinkingMs,
      toolMs: turn.toolMs,
      answerMs: turn.answerMs,
      sendToFirstActivityMs: ms(promptSentAt, firstActivityAt),
      sendToFirstTokenMs: ms(promptSentAt, firstTokenAt),
      firstTokenToEndMs: ms(firstTokenAt, endedAt),
      totalMs: ms(startedAt, endedAt)
    };
    const fmt = (n: number | null): string => (n === null ? '—' : `${n}ms`);
    const recallStr =
      r.total === undefined
        ? ''
        : ` recall=${fmt(r.total ?? null)}[facts=${fmt(r.facts ?? null)} embed=${fmt(r.embed ?? null)}` +
          ` rerank=${fmt(r.rerank ?? null)} search=${fmt(r.search ?? null)}]`;
    console.log(
      `[turn timing] build=${fmt(breakdown.buildMs)}${recallStr} ` +
        `think=${fmt(breakdown.thinkingMs)} tools=${fmt(breakdown.toolMs)} answer=${fmt(breakdown.answerMs)} ` +
        `send→first=${fmt(breakdown.sendToFirstTokenMs)} ` +
        `first→end=${fmt(breakdown.firstTokenToEndMs)} total=${fmt(breakdown.totalMs)}` +
        (breakdown.ensureMs ? ` (ensure=${breakdown.ensureMs}ms)` : '')
    );
    // Stash for recordTurnEntry to persist once the assistant entry id resolves.
    turn.timing = breakdown;
    this.emitEvent('turn/timing', breakdown);
  }

  private async recordTurnEntry(turn: TurnContext): Promise<void> {
    try {
      if (!this.proc || this.activeThreadId !== turn.threadId) return;
      const fm = await this.proc.request({ type: 'get_fork_messages' });
      const entries = (fm.data as { messages?: { entryId: string }[] } | undefined)?.messages ?? [];
      const last = entries[entries.length - 1];
      if (!last) return;
      this.turnEntryIds.set(turn.turnId, last.entryId);
      // Persist timing keyed by the FINAL assistant entry id — readThread rebuilds
      // that same bubble from entry.id on reopen, so the lookup matches.
      const b = turn.timing;
      if (b) {
        upsertTurnTiming({
          turnEntryId: last.entryId,
          threadId: turn.threadId,
          totalMs: b.totalMs,
          thinkingMs: b.thinkingMs,
          toolMs: b.toolMs,
          answerMs: b.answerMs,
          ttftMs: b.sendToFirstTokenMs,
          buildMs: b.buildMs,
          recallMs: b.recall.total
        });
      }
      // Persist the turn's tool activity + web sources next to the timing (same
      // entry-id keying) so activity rows survive reopen.
      if (turn.activity.length || turn.sources.length) {
        upsertTurnActivity({
          turnEntryId: last.entryId,
          threadId: turn.threadId,
          payload: { activity: turn.activity, sources: turn.sources }
        });
      }
    } catch {
      // best-effort; rollback/fork will surface a clear error if unresolved
    }
  }

  /** Resolve a renderer turnId to a pi session entry id (identity for reloaded threads). */
  private resolveEntryId(turnId: string): string {
    return this.turnEntryIds.get(turnId) ?? turnId;
  }

  private finishTurn(): void {
    this.currentTurn = null;
    this.foreground.finishTurn();
    // An approved MCP add/remove, or a skill written this turn, takes effect by
    // reloading the bridge after the turn (restarting mid-turn would kill the
    // in-flight conversation, and deferring keeps the prompt cache valid).
    if (this.pendingMcpReload || this.pendingSkillReload) {
      this.pendingMcpReload = false;
      this.pendingSkillReload = false;
      void this.configMcpServerReload().catch(() => undefined);
    }
  }

  /** Read the skills revision marker the bridge bumps on every skill write. */
  private readSkillsRev(): string {
    try {
      return readFileSync(join(skillsRoot(), SKILLS_REV_FILE), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Apply skill changes made out-of-band (the background curator writes SKILL.md
   * files directly). Reloads now when idle, or defers to turn end if a turn is
   * mid-flight. Also notifies the UI so the skills list refreshes.
   */
  async requestSkillReload(): Promise<void> {
    this.emitEvent('skills/changed');
    if (this.currentTurn) {
      this.pendingSkillReload = true;
      return;
    }
    await this.restart();
  }

  /**
   * The bridge asked (via a sentinel confirm) to apply an assistant-proposed MCP
   * add/remove. Hold the request open and surface it as Stem's McpApprovalCard;
   * resolveAdminApproval answers it once the user decides (or a timeout declines).
   */
  private handleAdminApproval(id: string, message: string | undefined): void {
    let proposal: { action?: string; name?: string; input?: McpServerInput } | null = null;
    try {
      proposal = JSON.parse(message ?? '{}');
    } catch {
      // malformed
    }
    if (!proposal || (proposal.action !== 'add' && proposal.action !== 'remove')) {
      this.proc?.send({ type: 'extension_ui_response', id, confirmed: false });
      return;
    }
    this.adminApprovals.add(id);
    const card: McpAdminProposal = {
      id,
      threadId: this.currentTurn?.threadId ?? '',
      action: proposal.action,
      input: proposal.input,
      name: proposal.name
    };
    // Keep the full mutation (including credentials) only in main-memory for the
    // accepted writer. Renderer approval cards need presence/keys, never values.
    const requestProcess = this.proc;
    this.adminApprovalProposals.set(id, { proposal: card, process: requestProcess });
    const displayInput = card.input
      ? {
          ...card.input,
          ...(card.input.oauthClientSecret ? { oauthClientSecret: '********' } : {}),
          ...(card.input.headers
            ? { headers: Object.fromEntries(Object.keys(card.input.headers).map((key) => [key, '********'])) }
            : {}),
          ...(card.input.env
            ? { env: Object.fromEntries(Object.keys(card.input.env).map((key) => [key, '********'])) }
            : {})
        }
      : undefined;
    this.emitEvent('mcp/admin/approvalRequest', { ...card, input: displayInput });
    setTimeout(() => {
      if (this.settleAdminApproval(id)) {
        requestProcess?.send({ type: 'extension_ui_response', id, confirmed: false });
      }
    }, 120_000);
  }

  /**
   * The bridge asked (via a sentinel confirm) to apply an assistant-proposed
   * custom-instructions change. Hold the request open and surface it as the
   * InstructionsApprovalCard; resolveInstructionsApproval answers once the user
   * decides (or a timeout declines). Main writes settings.json on accept.
   */
  private handleInstructionsApproval(id: string, message: string | undefined): void {
    let proposal: { action?: string; incomingText?: string; surface?: string } | null = null;
    try {
      proposal = JSON.parse(message ?? '{}');
    } catch {
      // malformed
    }
    const action = proposal?.action;
    if (action !== 'append' && action !== 'replace' && action !== 'clear') {
      this.proc?.send({ type: 'extension_ui_response', id, confirmed: false });
      return;
    }
    this.instructionsApprovals.add(id);
    const requestProcess = this.proc;
    this.instructionsApprovalProcesses.set(id, requestProcess);
    const card: InstructionsProposal = {
      id,
      threadId: this.currentTurn?.threadId ?? '',
      action,
      incomingText: typeof proposal?.incomingText === 'string' ? proposal.incomingText : '',
      suggestedSurface: proposal?.surface === 'quickChat' ? 'quickChat' : proposal?.surface === 'main' ? 'main' : undefined
    };
    this.emitEvent('instructions/approvalRequest', card);
    setTimeout(() => {
      if (this.settleInstructionsApproval(id)) {
        requestProcess?.send({ type: 'extension_ui_response', id, confirmed: false });
      }
    }, 120_000);
  }

  /** Start a fresh session on the foreground process; returns its sessionId. */
  private async newSession(): Promise<string> {
    const created = await this.proc!.request({ type: 'new_session' });
    if (!created.success) throw new Error(created.error ?? 'pi could not start a new chat.');
    // A fresh pi session resets the active model to the spawn default — invalidate the
    // mirrors so the next applyModel/setThinking re-issue their RPCs.
    this.currentModel = null;
    this.currentThinking = null;
    this.activeThreadId = null;
    const state = await this.proc!.request({ type: 'get_state' });
    if (!state.success) throw new Error(state.error ?? 'pi could not read the new chat state.');
    const id = this.recordState(state.data);
    if (!id) throw new Error('pi did not return a session id.');
    this.activeThreadId = id;
    return id;
  }

  /** Make `threadId` the active session, switching to its file if needed. */
  private async ensureActive(threadId: string): Promise<string> {
    if (this.activeThreadId === threadId) return threadId;
    const file = await this.resolveSessionFile(threadId);
    if (!file) {
      // Unknown/empty thread (e.g. pre-created, no messages yet): start fresh and
      // adopt the id the caller expects by treating the new session as active.
      const id = await this.newSession();
      return id;
    }
    const switched = await this.proc!.request({ type: 'switch_session', sessionPath: file });
    if (!switched.success) throw new Error(switched.error ?? `pi could not switch to chat "${threadId}".`);
    // The loaded session restores its OWN persisted model/thinking — invalidate the mirrors.
    this.currentModel = null;
    this.currentThinking = null;
    this.activeThreadId = threadId;
    return threadId;
  }

  private async applyModel(model: string): Promise<void> {
    if (model === this.currentModel) return;
    const { provider, modelId } = this.parseModel(model);
    const res = await this.proc!.request({ type: 'set_model', provider, modelId });
    if (!res.success) throw new Error(res.error ?? `pi could not select model "${model}".`);
    this.currentModel = model;
  }

  private async setThinking(effort: string): Promise<void> {
    const level = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : 'medium';
    if (level === this.currentThinking) return;
    const res = await this.proc!.request({ type: 'set_thinking_level', level }).catch(() => null);
    if (res?.success) this.currentThinking = level;
  }

  private parseModel(model: string): { provider: string; modelId: string } {
    const i = model.indexOf('/');
    if (i === -1) return { provider: DEFAULT_PROVIDER, modelId: model };
    return { provider: model.slice(0, i), modelId: model.slice(i + 1) };
  }

  /**
   * The app-level default model: the persisted post-onboarding choice (matched to
   * the provider the user signed in with), else the built-in codex constant.
   */
  private async resolveDefaultModel(): Promise<{ provider: string; modelId: string }> {
    try {
      const { defaults } = await readSettings();
      if (defaults.model) return this.parseModel(defaults.model);
    } catch {
      // settings unreadable → constant
    }
    return { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL };
  }

  /** Assemble the prompt: prepend recall/files/format context (pi has no per-turn context field). */
  private async buildMessage(
    input: StartTurnInput,
    threadId: string,
    recallTimings?: RecallTimings,
    turnId?: string
  ): Promise<{ message: string; images: PiImageContent[] }> {
    const blocks: string[] = [];
    // The user's standing custom instructions — an AUTHORITATIVE block, first and
    // distinct from recall (which is explicitly "not instructions"). Already resolved
    // per surface by the caller (main vs Quick Chat). Empty → no block.
    const standing = input.instructions?.trim();
    if (standing) {
      blocks.push(
        `Standing instructions from the user (high-priority directives — follow them in every reply; ` +
          `they override your default behavior for verbosity, output format, and component usage; only the ` +
          `user's current message and safety take precedence):\n${standing}`
      );
    }
    if (isRecallEnabled()) {
      const chosen: { facts: Fact[]; tier: FactTier } = { facts: [], tier: 'all' };
      const recall = await buildRecallContext(input.input, {
        currentThreadId: threadId,
        timings: recallTimings,
        chosen
      });
      if (recall) blocks.push(recall);
      // Record what was injected so the Memory UI can show this chat's active facts.
      try {
        setActiveFacts(
          threadId,
          chosen.facts.map((f) => ({ id: f.id, reason: f.selectionReason })),
          chosen.tier
        );
        // Also log this turn's injected set for the distill pass to grade
        // ("which of these facts did the reply actually use?") — the feedback
        // signal behind usage-aware fact ranking. The captured user/assistant
        // messages carry the same turnId, which is the join key.
        if (turnId && chosen.facts.length > 0) {
          recordTurnInjectedFacts(threadId, turnId, chosen.facts.map((f) => f.id));
        }
      } catch {
        // Debug surface only — never let it break a turn.
      }
    }
    const files = await buildFilesContext();
    if (files) blocks.push(files);
    const connected = await buildConnectedFoldersContext();
    if (connected) blocks.push(connected);
    // Cheap names+signatures catalog of routed MCP tools (schemas fetched on demand
    // via describe_tool). Keeps the prompt floor flat as more servers are added.
    const catalog = buildMcpCatalogContext();
    if (catalog) blocks.push(catalog);
    if (input.format === 'md') blocks.push(PLAIN_MD_DIRECTIVE);

    // Images go to pi natively; text-like files are inlined, binaries noted and dropped.
    const { images, textBlocks, rejected } = await resolveAttachments(input.attachments ?? []);

    // The user's text comes last; context blocks precede it across a `---` rule, while
    // inlined files and skip notes attach to the user turn just after their message.
    const tail: string[] = [];
    if (textBlocks.length) tail.push(textBlocks.join('\n\n'));
    if (rejected.length) tail.push(`(Skipped unsupported attachment: ${rejected.join(', ')})`);
    const userText = tail.length ? `${input.input}\n\n${tail.join('\n\n')}` : input.input;

    // Fence the injected context so replay can strip it (see CONTEXT_* above): the
    // model still sees it inline, but the stored user bubble renders only userText.
    const body = blocks.length
      ? `${CONTEXT_OPEN}\n${blocks.join('\n\n')}\n\n---\n${CONTEXT_CLOSE}\n\n${userText}`
      : userText;
    // A scheduled run prepends its fenced preamble (before the context fence) so the
    // model knows it's running headless and the persisted message carries the marker.
    const message = input.scheduled ? `${scheduledPreamble(input.scheduled.at)}\n\n${body}` : body;
    return { message, images };
  }

  private recordState(data: unknown): string | null {
    const s = data as { sessionId?: string; sessionFile?: string } | undefined;
    const id = s?.sessionId ?? null;
    if (id && s?.sessionFile) this.sessionFiles.set(id, s.sessionFile);
    if (id) this.activeThreadId = this.activeThreadId ?? id;
    return id;
  }

  private async resolveSessionFile(threadId: string): Promise<string | null> {
    const cached = this.sessionFiles.get(threadId);
    if (cached && (await this.fileExists(cached))) return cached;
    const files = await this.scanSessions();
    for (const f of files) this.sessionFiles.set(f.id, f.path);
    return this.sessionFiles.get(threadId) ?? null;
  }

  /** Walk the session dir and read each JSONL header + name for the chat list. */
  private async scanSessions(): Promise<SessionFile[]> {
    const seen = new Set<string>();
    const walk = async (dir: string): Promise<SessionFile[]> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const results = await Promise.all(
        entries.map(async (entry): Promise<SessionFile[]> => {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) return walk(full);
          if (!entry.name.endsWith('.jsonl')) return [];
          seen.add(full);
          // stat first (cheap); reuse cached metadata when the file is unchanged.
          let mtimeMs: number | null = null;
          try {
            mtimeMs = Math.floor((await stat(full)).mtimeMs);
          } catch {
            return [];
          }
          const cached = this.metaCache.get(full);
          if (cached && cached.mtimeMs === mtimeMs) return [cached.meta];
          const meta = await this.readSessionMeta(full, mtimeMs);
          if (!meta) return [];
          this.metaCache.set(full, { mtimeMs, meta });
          return [meta];
        })
      );
      return results.flat();
    };
    const out = await walk(this.options.sessionsDir);
    // Drop cache entries for files that disappeared (deleted/moved threads).
    for (const path of this.metaCache.keys()) if (!seen.has(path)) this.metaCache.delete(path);
    return out;
  }

  private async readSessionMeta(path: string, mtimeMs: number): Promise<SessionFile | null> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    const lines = text.split('\n').filter((l) => l.trim());
    if (!lines.length) return null;
    let id = '';
    let cwd: string | null = null;
    let createdAt = 0;
    let name: string | null = null;
    try {
      const header = JSON.parse(lines[0]) as { id?: string; cwd?: string; timestamp?: string };
      id = header.id ?? '';
      cwd = header.cwd ?? null;
      createdAt = header.timestamp ? Date.parse(header.timestamp) || 0 : 0;
    } catch {
      return null;
    }
    if (!id) return null;
    // Latest session_info name wins (mirrors pi's getSessionName).
    for (const line of lines) {
      if (!line.includes('"session_info"')) continue;
      try {
        const e = JSON.parse(line) as { type?: string; name?: string };
        if (e.type === 'session_info' && typeof e.name === 'string') name = e.name;
      } catch {
        // ignore
      }
    }
    return { id, path, name, cwd, createdAt: Math.floor(createdAt), updatedAt: mtimeMs };
  }

  /** Read the live foreground session's messages (for active sessions without a file yet). */
  private async readActiveMessages(): Promise<{ title: string; messages: ChatMessage[] }> {
    const res = await this.proc!.request({ type: 'get_messages' });
    const raw =
      (res.data as { messages?: { role?: string; content?: unknown; provider?: string; model?: string }[] } | undefined)
        ?.messages ?? [];
    const messages: ChatMessage[] = [];
    for (const m of raw) {
      const { text: content, images, scheduled } = this.contentToParts(m.content);
      if (!content.trim() && !images.length) continue;
      if (m.role === 'user')
        messages.push({
          id: `user-${messages.length}`,
          role: 'user',
          content,
          ...(images.length ? { attachments: images } : {}),
          ...(scheduled ? { scheduled } : {})
        });
      else if (m.role === 'assistant') {
        // Same hover label as readThread: pi's message objects carry provider+model;
        // effort mirrors the live session's current thinking level (no per-message
        // record here, but this path only serves the just-created active session).
        const model = m.provider && m.model ? `${m.provider}/${m.model}` : undefined;
        const meta: MessageMeta | undefined =
          model || this.currentThinking
            ? { ...(model ? { model } : {}), ...(this.currentThinking ? { effort: this.currentThinking } : {}) }
            : undefined;
        messages.push({
          id: `assistant-${messages.length}`,
          role: 'assistant',
          content,
          ...(meta ? { meta } : {})
        });
      }
    }
    const state = await this.proc!.request({ type: 'get_state' });
    const title = ((state.data as { sessionName?: string } | undefined)?.sessionName || 'New chat').trim() || 'New chat';
    return { title, messages };
  }

  /** Parse a JSONL session line's entry id (null if not a tree entry). */
  private entryIdOf(line: string): string | null {
    try {
      return (JSON.parse(line) as { id?: string }).id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Split a persisted message `content` into rendered text and image attachments. pi
   * stores images as `{type:'image', data, mimeType}` blocks alongside text blocks, so
   * replay rebuilds thumbnails straight from the session JSONL.
   */
  private contentToParts(content: unknown): {
    text: string;
    images: MessageAttachment[];
    scheduled?: { at: string };
  } {
    if (typeof content === 'string') return this.stripMarkers(content, []);
    if (!Array.isArray(content)) return { text: '', images: [] };
    const texts: string[] = [];
    const images: MessageAttachment[] = [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const part = c as { type?: string; text?: string; data?: string; mimeType?: string };
      if (part.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text);
      } else if (part.type === 'image' && typeof part.data === 'string') {
        const mime = part.mimeType || 'image/png';
        images.push({ kind: 'image', mime, dataUrl: `data:${mime};base64,${part.data}` });
      }
    }
    return this.stripMarkers(texts.join(''), images);
  }

  /**
   * Strip the fenced scheduled-run preamble and recall/files/format context we
   * prepended at send time so the replayed user bubble shows only what was actually
   * asked. The scheduled fence also flags the turn (with its timestamp) so the UI
   * renders it collapsed. No-op on turns with no injection and on assistant messages.
   */
  private stripMarkers(raw: string, images: MessageAttachment[]): {
    text: string;
    images: MessageAttachment[];
    scheduled?: { at: string };
  } {
    const sched = raw.match(SCHED_STRIP_RE);
    const text = raw.replace(SCHED_STRIP_RE, '').replace(CONTEXT_STRIP_RE, '');
    return sched ? { text, images, scheduled: { at: sched[1] } } : { text, images };
  }

  // Last local-provider catalog sync (models.json); throttles listModels re-probes.
  private lastLocalSyncAt = 0;

  /**
   * Keep the local-provider catalog fresh: re-probe enabled Ollama/LM Studio
   * servers at most every 30s so newly pulled models appear without an app
   * restart. pi's RPC mode loads models.json once at spawn, so a content change
   * needs a process restart — done only when no turn is streaming; otherwise the
   * next sync (or any restart) catches up.
   */
  private async maybeRefreshLocalModels(): Promise<void> {
    if (Date.now() - this.lastLocalSyncAt < 30_000) return;
    this.lastLocalSyncAt = Date.now();
    try {
      const { localProviders } = await readSettings();
      if (!Object.values(localProviders).some((p) => p.enabled)) return;
      const changed = await syncModelsConfig(localProviders);
      if (changed && this.proc?.running && !this.currentTurn) await this.restart();
    } catch {
      // non-fatal: the model list just stays as pi last loaded it
    }
  }

  /** Providers Stem has credentials for (from the isolated auth.json). */
  private async authProviders(): Promise<Set<string>> {
    try {
      const raw = await readFile(join(this.options.piHome, 'auth.json'), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
      const providers = new Set<string>();
      const apiKeyProviders = new Set<string>([...API_KEY_PROVIDER_IDS, ...LOCAL_PROVIDER_IDS]);
      const oauthProviders = new Set<string>(AUTH_PROVIDER_IDS);
      for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const credential = value as {
          type?: unknown;
          key?: unknown;
          access?: unknown;
          refresh?: unknown;
          expires?: unknown;
        };
        const hasApiKey =
          apiKeyProviders.has(provider) &&
          credential.type === 'api_key' &&
          typeof credential.key === 'string' &&
          credential.key.trim().length > 0;
        const accessUsable = typeof credential.access === 'string' && credential.access.trim().length > 0;
        const refreshUsable = typeof credential.refresh === 'string' && credential.refresh.trim().length > 0;
        const expiry = typeof credential.expires === 'number' && Number.isFinite(credential.expires)
          ? credential.expires
          : null;
        const hasOAuth =
          oauthProviders.has(provider) &&
          credential.type === 'oauth' &&
          accessUsable &&
          typeof credential.refresh === 'string' &&
          expiry !== null &&
          (expiry > Date.now() || refreshUsable);
        if (hasApiKey || hasOAuth) providers.add(provider);
      }
      return providers;
    } catch {
      return new Set();
    }
  }

  /**
   * Ensure the isolated pi home exists and is authenticated. Seeds auth.json from
   * the user's global ~/.pi/agent the first time so the backend works without a
   * separate login, while keeping skills/config/sessions sandboxed under piHome.
   */
  private async ensurePiHome(): Promise<void> {
    await mkdir(this.options.piHome, { recursive: true });
    await mkdir(this.options.sessionsDir, { recursive: true });
    await mkdir(join(this.options.workspaceRoot, '.stem-internal'), { recursive: true });
    const dest = join(this.options.piHome, 'auth.json');
    if (this.options.seedGlobalAuth !== false && !(await this.fileExists(dest))) {
      const src = join(homedir(), '.pi', 'agent', 'auth.json');
      if (await this.fileExists(src)) await copyFile(src, dest).catch(() => undefined);
    }
    // Ensure mcp.json (with the reserved stem-recall entry) for the bridge extension.
    await ensureMcpConfig().catch(() => undefined);
    // Stamp pre-identity-migration OAuth tokens before the bridge reads them, or
    // every previously-signed-in remote server connects unauthenticated (401).
    await migrateLegacyOAuthTokens().catch(() => undefined);
    // Prefer pi's SSE transport over its default WebSocket-first "auto".
    await this.ensurePiTransportDefault().catch(() => undefined);
  }

  /**
   * Seed `transport: "sse"` into pi's settings.json (read once at spawn — see the
   * pi RPC no-hot-reload note). pi's codex/ChatGPT transport is WebSocket-first,
   * but a WebSocket that drops MID-stream cannot be retried (replaying would re-run
   * tools it already executed — openai-codex-responses throws once websocketStarted),
   * so a transient disconnect hard-fails the whole turn even though its side effects
   * (e.g. a scheduled reminder) already committed. The SSE fetch path instead retries
   * transient errors with backoff and is sturdier through network filters (Little
   * Snitch). Only seed when unset — an explicit transport in the file wins — and never
   * clobber existing/hand-authored settings.
   */
  private async ensurePiTransportDefault(): Promise<void> {
    const file = join(this.options.piHome, 'settings.json');
    let raw: string | null = null;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      raw = null; // absent — we create it
    }
    let settings: Record<string, unknown>;
    if (raw === null) {
      settings = {};
    } else {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return; // unexpected shape — leave it
        settings = parsed as Record<string, unknown>;
      } catch {
        return; // present but malformed — never destroy hand-authored content
      }
    }
    if ('transport' in settings) return; // respect an explicit choice
    settings.transport = 'sse';
    await writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Diagnostics-only: how to reach this exact pi + home from a terminal. */
  private loginCommand(pi: PiInvocation): string {
    const extra = pi.env.ELECTRON_RUN_AS_NODE ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
    const argv = [pi.command, ...pi.prefixArgs].map((a) => `"${a}"`).join(' ');
    return `env PI_CODING_AGENT_DIR="${this.options.piHome}" ${extra}${argv}`;
  }

  private sanitizedEnv(pi?: PiInvocation): NodeJS.ProcessEnv {
    const env = { ...process.env, ...(pi?.env ?? {}) };
    env.PI_CODING_AGENT_DIR = this.options.piHome;
    env.PI_CODING_AGENT_SESSION_DIR = this.options.sessionsDir;
    env.PI_SKIP_VERSION_CHECK = '1';
    // Tell the bridge extension where Stem's MCP config lives.
    env[ENV_MCP_CONFIG] = piMcpConfigPath();
    env[ENV_MCP_OAUTH] = piMcpOAuthPath();
    // The bridge decrypts/re-encrypts MCP secrets with the same key main uses
    // (safeStorage is main-process-only). Unset in plaintext mode.
    const secretKey = secretKeyHex();
    if (secretKey) env[ENV_SECRET_KEY] = secretKey;
    // Tell the bridge extension where the assistant's self-authored skills live.
    env[ENV_SKILLS_DIR] = skillsRoot();
    return env;
  }
}
