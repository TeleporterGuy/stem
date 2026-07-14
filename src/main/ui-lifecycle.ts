import type { BackendEventEnvelope, QuickChatHandoff } from '../shared/types';

export interface RendererPushMessage {
  channel: string;
  payload: unknown;
}

/** Buffers main-window pushes until React explicitly confirms its listeners exist. */
export class RendererPushQueue {
  private ready = false;
  private pending: RendererPushMessage[] = [];

  reset(): void {
    this.ready = false;
    this.pending = [];
  }

  push(message: RendererPushMessage): RendererPushMessage[] {
    if (this.ready) return [message];
    this.pending.push(message);
    return [];
  }

  markReady(): RendererPushMessage[] {
    this.ready = true;
    const queued = this.pending;
    this.pending = [];
    return queued;
  }
}

/** Keeps a manual Quick Chat reset pending until its old turn terminal event (or
 * process exit) has been observed and routed under the old ownership. */
export class QuickChatResetBarrier {
  private waiters: Array<() => void> = [];

  get pending(): boolean {
    return this.waiters.length > 0;
  }

  wait(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  settle(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

export interface QuickChatProcessState {
  threadId: string | null;
  handedOff: boolean;
  turnRunning: boolean;
  lastActivityAt: number;
  hudTextSeen: boolean;
}

/**
 * State transition for a crashed Quick Chat turn. Keep the owning thread so the
 * user can retry/resume it after the backend restarts; only the live turn/HUD
 * state is settled. A pending explicit New Thread reset clears ownership after
 * this transition via QuickChatResetBarrier.
 */
export function failQuickChatProcess(now: number, threadId: string | null): QuickChatProcessState {
  return {
    threadId,
    handedOff: false,
    turnRunning: false,
    lastActivityAt: now,
    hudTextSeen: false
  };
}

export interface QuickChatHandoffTicket {
  id: string;
  promise: Promise<QuickChatHandoff | null>;
  fresh: boolean;
}

export interface QuickChatHandoffTransition {
  snapshot: QuickChatHandoff;
  events: BackendEventEnvelope[];
}

/**
 * Atomic ownership barrier for an implicit Quick Chat handoff. Events emitted
 * after the snapshot request are buffered in main, then replayed after the
 * renderer snapshot is adopted, so neither pre-request nor last-millisecond
 * deltas can fall between the two windows.
 */
export class QuickChatHandoffBarrier {
  private sequence = 0;
  private pending: {
    id: string;
    threadId: string;
    snapshot: QuickChatHandoff | null;
    events: BackendEventEnvelope[];
    promise: Promise<QuickChatHandoff | null>;
    resolve: (snapshot: QuickChatHandoff | null) => void;
  } | null = null;

  begin(threadId: string): QuickChatHandoffTicket {
    if (this.pending) {
      if (this.pending.threadId !== threadId) throw new Error('Another Quick Chat handoff is already pending.');
      return { id: this.pending.id, promise: this.pending.promise, fresh: false };
    }
    let resolve!: (snapshot: QuickChatHandoff | null) => void;
    const promise = new Promise<QuickChatHandoff | null>((done) => {
      resolve = done;
    });
    const id = `qc-handoff-${++this.sequence}`;
    this.pending = { id, threadId, snapshot: null, events: [], promise, resolve };
    return { id, promise, fresh: true };
  }

  buffer(threadId: string, event: BackendEventEnvelope): boolean {
    if (!this.pending || this.pending.threadId !== threadId) return false;
    this.pending.events.push(event);
    return true;
  }

  supply(id: string, snapshot: QuickChatHandoff): boolean {
    const pending = this.pending;
    if (!pending || pending.id !== id || snapshot.threadId !== pending.threadId || pending.snapshot) return false;
    pending.snapshot = snapshot;
    pending.resolve(snapshot);
    return true;
  }

  commit(id: string): QuickChatHandoffTransition | null {
    const pending = this.pending;
    if (!pending || pending.id !== id || !pending.snapshot) return null;
    this.pending = null;
    return { snapshot: pending.snapshot, events: pending.events };
  }

  cancel(id: string): BackendEventEnvelope[] {
    const pending = this.pending;
    if (!pending || pending.id !== id) return [];
    this.pending = null;
    pending.resolve(null);
    return pending.events;
  }

  cancelCurrent(): BackendEventEnvelope[] {
    return this.pending ? this.cancel(this.pending.id) : [];
  }
}

export const CHAT_SEARCH_COMPLETION_TIMEOUT_MS = 4_000;
