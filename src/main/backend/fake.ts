import { EventEmitter } from 'node:events';
import type { ChatBackend, TaskBridge } from './types';
import type {
  ChatMessage,
  ChatSummary,
  McpAdminProposal,
  McpLoginResult,
  ModelSummary,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../../shared/types';
import { readTasks } from '../workspace/tasks';

// Hermetic ChatBackend for STEM_E2E runs: the full turn lifecycle — send →
// streamed deltas → completed/failed/aborted, thread CRUD, retry/edit/fork —
// without a pi process, auth, or network. Everything downstream of the seam
// (IPC, event routing, both renderers, Recall capture, chat search indexing,
// the scheduler) runs for real against deterministic scripted turns.
//
// Turn scripting via markers in the prompt text:
//   [e2e:hang] — stream one delta, then stay running until interrupted
//   [e2e:fail] — fail the turn after one delta
//   otherwise  — stream "Echo: <text>" in a few deltas, then complete
//
// STEM_E2E_ONBOARDING starts the fake UNAUTHENTICATED; login() (wired to the
// scripted auth:providerLogin/auth:setApiKey handlers) flips it, mimicking a
// real sign-in.

const MODEL: ModelSummary = {
  id: 'e2e/stem-e2e-model',
  displayName: 'Stem E2E model',
  description: 'e2e',
  provider: 'e2e',
  providerName: 'E2E',
  supportsNativeWebSearch: false,
  supportedEfforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium',
  serviceTiers: [],
  isDefault: true
};

/** Interval between scripted stream events — long enough for Playwright to observe streaming. */
const STEP_MS = 15;

interface FakeThread {
  title: string;
  messages: ChatMessage[];
  createdAt: number; // unix seconds, ChatSummary convention
  updatedAt: number;
  /**
   * pi threads join listThreads only once a turn has persisted a session file
   * (createThread/forkThread alone don't). Mirrored here so sidebar-count
   * expectations hold across both backends.
   */
  listed: boolean;
}

interface ActiveTurn {
  turnId: string;
  threadId: string;
  text: string;
  timer: NodeJS.Timeout | null;
  hang: boolean;
}

export interface FakeBackendOptions {
  piHome: string;
  workspaceRoot: string;
  /** false = the onboarding sub-seam: unauthenticated until login(). */
  startAuthenticated: boolean;
}

export class FakeBackend extends EventEmitter implements ChatBackend {
  private authed: boolean;
  private threads = new Map<string, FakeThread>();
  private seq = 0;
  private activeTurn: ActiveTurn | null = null;

  constructor(private readonly options: FakeBackendOptions) {
    super();
    this.authed = options.startAuthenticated;
  }

  // ---- lifecycle / auth ----

  async status(): Promise<RuntimeStatus> {
    const base = {
      backendPath: null,
      backendHome: this.options.piHome,
      workspaceRoot: this.options.workspaceRoot
    };
    return this.authed
      ? { ...base, ok: true, authenticated: true }
      : { ...base, ok: false, authenticated: false, providers: [], error: 'Stem is not signed in yet.' };
  }

  async login(): Promise<RuntimeStatus> {
    this.authed = true;
    return this.status();
  }

  async restart(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.clearActiveTimer();
  }

  async newConversation(): Promise<void> {}

  async prewarm(): Promise<void> {}

  // ---- turns ----

  async createThread(_model?: string): Promise<string> {
    const threadId = `e2e-thread-${++this.seq}`;
    this.ensureThread(threadId);
    return threadId;
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const threadId = input.threadId ?? (await this.createThread(input.model));
    const turnId = `e2e-turn-${++this.seq}`;
    const thread = this.ensureThread(threadId);
    const text = input.input;
    if (!thread.title) thread.title = text.split('\n')[0]?.slice(0, 80) ?? '';
    thread.listed = true;
    thread.updatedAt = Math.floor(Date.now() / 1000);
    thread.messages.push({
      id: `user-${turnId}`,
      role: 'user',
      content: text,
      turnId,
      createdAt: new Date().toISOString(),
      ...(input.scheduled ? { scheduled: { at: input.scheduled.at } } : {})
    });

    const turn: ActiveTurn = { turnId, threadId, text, timer: null, hang: text.includes('[e2e:hang]') };
    this.activeTurn = turn;
    this.runScript(turn);
    return { threadId, turnId };
  }

  async interruptTurn(turnId: string): Promise<void> {
    const turn = this.activeTurn;
    if (!turn || turn.turnId !== turnId) return;
    this.clearActiveTimer();
    this.activeTurn = null;
    this.settle(turn, 'aborted');
  }

  async listModels(): Promise<ModelSummary[]> {
    return [MODEL];
  }

  async complete(): Promise<string> {
    return '';
  }

  isInternalThread(): boolean {
    return false;
  }

  isCaptureSuppressed(): boolean {
    return false;
  }

  // ---- thread CRUD ----

  async listThreads(): Promise<ChatSummary[]> {
    const rows: ChatSummary[] = [...this.threads.entries()]
      .filter(([, t]) => t.listed)
      .map(([threadId, t]) => ({
        threadId,
        title: t.title || 'New chat',
        folderId: null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      }));
    // Seeded scheduled tasks reference threads that were never chatted in this
    // run — report them as existing so the scheduler's thread-deleted guard
    // doesn't remove the tasks at startup (specs seed tasks, never sessions).
    for (const task of await readTasks()) {
      if (!rows.some((r) => r.threadId === task.threadId)) {
        rows.push({ threadId: task.threadId, title: task.title ?? '', folderId: null, createdAt: 0, updatedAt: 0 });
      }
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async readThread(threadId: string): Promise<{ title: string; messages: ChatMessage[] }> {
    const thread = this.threads.get(threadId);
    return { title: thread?.title ?? '', messages: [...(thread?.messages ?? [])] };
  }

  async resumeThread(_threadId: string): Promise<void> {}

  async renameThread(threadId: string, name: string): Promise<void> {
    this.ensureThread(threadId).title = name;
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
  }

  async rollbackToTurn(threadId: string, turnId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const at = thread.messages.findIndex((m) => m.turnId === turnId);
    if (at !== -1) thread.messages = thread.messages.slice(0, at);
  }

  async forkThread(threadId: string, turnId: string): Promise<{ threadId: string }> {
    const source = this.threads.get(threadId);
    if (!source) throw new Error(`No such thread: ${threadId}`);
    const last = source.messages.map((m) => m.turnId).lastIndexOf(turnId);
    if (last === -1) throw new Error(`No such turn in thread: ${turnId}`);
    const forkId = `e2e-thread-${++this.seq}`;
    const now = Math.floor(Date.now() / 1000);
    this.threads.set(forkId, {
      title: source.title,
      messages: source.messages.slice(0, last + 1).map((m) => ({ ...m })),
      createdAt: now,
      updatedAt: now,
      listed: false
    });
    return { threadId: forkId };
  }

  // ---- MCP / skills / tasks (inert) ----

  async mcpLogin(_name: string): Promise<McpLoginResult> {
    return { ok: false, error: 'MCP login is not available in the e2e fake backend.' };
  }

  getMcpStatus(): Record<string, { status: string; error: string | null }> {
    return {};
  }

  async resolveAdminApproval(
    _id: number | string,
    _accept: boolean,
    _beforeAccept?: (proposal: McpAdminProposal) => Promise<void>
  ): Promise<boolean> {
    return false;
  }

  async resolveInstructionsApproval(): Promise<boolean> {
    return false;
  }

  async configMcpServerReload(): Promise<void> {}

  async requestSkillReload(): Promise<void> {}

  setTaskBridge(_bridge: TaskBridge | null): void {}

  // ---- scripted turn execution ----

  /** Emit the turn's event script step by step on a timer chain. */
  private runScript(turn: ActiveTurn): void {
    const { threadId, turnId, text } = turn;
    const fail = text.includes('[e2e:fail]');
    const reply = `Echo: ${text.replace(/\[e2e:[a-z]+\]/g, '').trim()}`;
    // A third each, split on word boundaries, so streaming is observable.
    const words = reply.split(' ');
    const third = Math.max(1, Math.ceil(words.length / 3));
    const chunks = [
      words.slice(0, third).join(' '),
      words.slice(third).length ? ' ' + words.slice(third, 2 * third).join(' ') : '',
      words.slice(2 * third).length ? ' ' + words.slice(2 * third).join(' ') : ''
    ].filter(Boolean);

    const steps: Array<() => void> = [];
    steps.push(() =>
      this.emitEvent('item/started', { item: { type: 'reasoning', id: turnId }, threadId, turnId })
    );
    let streamed = '';
    const deltasToEmit = turn.hang || fail ? chunks.slice(0, 1) : chunks;
    for (const chunk of deltasToEmit) {
      steps.push(() => {
        streamed += chunk;
        this.emitEvent('item/agentMessage/delta', { threadId, turnId, itemId: turnId, delta: chunk });
      });
    }
    if (fail) {
      steps.push(() => {
        if (this.activeTurn?.turnId === turnId) this.activeTurn = null;
        this.recordAssistant(turn, streamed);
        this.emitEvent('turn/failed', {
          threadId,
          turn: { id: turnId, status: 'failed' },
          error: 'E2E scripted failure'
        });
      });
    } else if (!turn.hang) {
      steps.push(() => {
        if (this.activeTurn?.turnId === turnId) this.activeTurn = null;
        this.recordAssistant(turn, reply);
        this.emitEvent('item/completed', {
          item: { type: 'agentMessage', id: turnId, text: reply },
          threadId,
          turnId
        });
        this.emitEvent('turn/usage', {
          threadId,
          turnId,
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          cost: null
        });
        this.emitEvent('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
      });
    }
    // [e2e:hang]: no terminal step — the turn stays running until interruptTurn.

    const step = (i: number): void => {
      if (this.activeTurn?.turnId !== turnId) return; // interrupted/superseded
      steps[i]();
      if (i + 1 < steps.length) {
        turn.timer = setTimeout(() => step(i + 1), STEP_MS);
      }
    };
    turn.timer = setTimeout(() => step(0), STEP_MS);
  }

  /** Emit the terminal event for an interrupt, persisting nothing extra. */
  private settle(turn: ActiveTurn, status: 'aborted'): void {
    this.emitEvent('turn/aborted', {
      threadId: turn.threadId,
      turn: { id: turn.turnId, status }
    });
  }

  private recordAssistant(turn: ActiveTurn, text: string): void {
    const thread = this.ensureThread(turn.threadId);
    thread.updatedAt = Math.floor(Date.now() / 1000);
    thread.messages.push({
      id: `assistant-${turn.turnId}`,
      role: 'assistant',
      content: text,
      turnId: turn.turnId,
      createdAt: new Date().toISOString()
    });
  }

  private ensureThread(threadId: string): FakeThread {
    let thread = this.threads.get(threadId);
    if (!thread) {
      const now = Math.floor(Date.now() / 1000);
      thread = { title: '', messages: [], createdAt: now, updatedAt: now, listed: false };
      this.threads.set(threadId, thread);
    }
    return thread;
  }

  private clearActiveTimer(): void {
    if (this.activeTurn?.timer) clearTimeout(this.activeTurn.timer);
  }

  private emitEvent(method: string, params?: unknown): void {
    this.emit('event', { method, params, receivedAt: new Date().toISOString() });
  }
}
