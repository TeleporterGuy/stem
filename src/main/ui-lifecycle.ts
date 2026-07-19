import type { BackendEventEnvelope, QuickChatHandoff, QuickChatStatusPhase } from '../shared/types';

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

/**
 * Single owner of the Quick Chat overlay's conversation state. The overlay owns
 * one live thread at a time: while it does, that thread's backend events route
 * to the overlay + HUD instead of the main window; a hand-off flips routing to
 * the main window for good. These fields used to be loose module globals in
 * index.ts mutated from ~9 call sites — every mutation now goes through a named
 * transition below, and readers get read-only views.
 */
export class OverlaySession {
  private threadIdValue: string | null = null;
  private handedOffValue = false;
  private turnRunningValue = false;
  private lastActivityAtValue = 0;
  private hudTextSeenValue = false;

  /** The overlay-owned thread, or null when no live session. */
  get threadId(): string | null {
    return this.threadIdValue;
  }

  /** True once the session's events route to the main window instead. */
  get handedOff(): boolean {
    return this.handedOffValue;
  }

  /** True while the overlay's current turn is still streaming. */
  get turnRunning(): boolean {
    return this.turnRunningValue;
  }

  /** Whether the in-flight turn has started streaming answer text (HUD phase). */
  get hudTextSeen(): boolean {
    return this.hudTextSeenValue;
  }

  /** True when `threadId`'s events belong to the overlay (owned, not handed off). */
  owns(threadId: string | null | undefined): boolean {
    return !!threadId && threadId === this.threadIdValue && !this.handedOffValue;
  }

  /**
   * Continue-vs-fresh decision on summon: fresh when there is no live session,
   * it was handed off, or it sat idle past the timeout — but never while a turn
   * is still streaming (resetting then would orphan a mid-stream thread).
   */
  shouldStartFresh(now: number, newThreadTimeoutMs: number): boolean {
    return (
      !this.threadIdValue ||
      this.handedOffValue ||
      (!this.turnRunningValue && newThreadTimeoutMs > 0 && now - this.lastActivityAtValue > newThreadTimeoutMs)
    );
  }

  /** Drop ownership entirely so the next prompt opens a fresh thread. */
  clearForFreshSession(): void {
    this.threadIdValue = null;
    this.handedOffValue = false;
    this.hudTextSeenValue = false;
  }

  /**
   * Manual "New Thread" while a turn may still be settling: clear everything
   * except the thread id, which must survive until the old turn's terminal
   * event has routed (then releaseThread() drops it — see QuickChatResetBarrier).
   */
  prepareManualReset(): void {
    this.handedOffValue = false;
    this.hudTextSeenValue = false;
  }

  /** Final step of a reset: stop owning the old thread. */
  releaseThread(): void {
    this.threadIdValue = null;
  }

  /** A prompt was submitted in the overlay: a turn is now in flight. */
  beginTurn(now: number): void {
    this.hudTextSeenValue = false;
    this.turnRunningValue = true;
    this.lastActivityAtValue = now;
  }

  /** A fresh session's thread was created: the overlay owns it from now on. */
  adoptThread(threadId: string): void {
    this.threadIdValue = threadId;
    this.handedOffValue = false;
  }

  /** Refresh the idle clock (prompt accepted, terminal event, …). */
  noteActivity(now: number): void {
    this.lastActivityAtValue = now;
  }

  /** The in-flight turn reached a terminal event. */
  settleTurn(now: number): void {
    this.turnRunningValue = false;
    this.lastActivityAtValue = now;
  }

  /** Stop the turn without touching the idle clock (hand-off adopts it mid-run). */
  stopTurn(): void {
    this.turnRunningValue = false;
  }

  /** First answer token streamed — the HUD flips to 'answering'. */
  noteAnswerText(): void {
    this.hudTextSeenValue = true;
  }

  /** Reset the HUD text phase for the next turn. */
  resetHudText(): void {
    this.hudTextSeenValue = false;
  }

  /**
   * Route future events to the main window. Returns true when THIS call flipped
   * the flag — the caller that flipped it may revertHandoff() if its transition
   * is subsequently cancelled; one that found it already flipped must not.
   */
  claimHandoff(): boolean {
    if (this.handedOffValue) return false;
    this.handedOffValue = true;
    return true;
  }

  /** Undo a claimHandoff() whose transition was cancelled mid-flight. */
  revertHandoff(): void {
    this.handedOffValue = false;
  }

  /** Restore after a backend crash (see failQuickChatProcess). */
  restore(state: QuickChatProcessState): void {
    this.threadIdValue = state.threadId;
    this.handedOffValue = state.handedOff;
    this.turnRunningValue = state.turnRunning;
    this.lastActivityAtValue = state.lastActivityAt;
    this.hudTextSeenValue = state.hudTextSeen;
  }
}

export type HudOwner = 'none' | 'quickchat' | 'main';

/**
 * Ownership + phase of the shared bottom-left status pill, so Quick Chat and the
 * follow-me (main-window) path never stomp each other and the finish chime fires
 * exactly once per transition into 'finished'.
 */
export class HudPill {
  private ownerValue: HudOwner = 'none';
  private lastPhaseValue: QuickChatStatusPhase | null = null;

  get owner(): HudOwner {
    return this.ownerValue;
  }

  get lastPhase(): QuickChatStatusPhase | null {
    return this.lastPhaseValue;
  }

  /** Record a status push; returns true when this ENTERS 'finished' (chime moment). */
  notePush(owner: Exclude<HudOwner, 'none'>, phase: QuickChatStatusPhase): boolean {
    const enteredFinished = phase === 'finished' && this.lastPhaseValue !== 'finished';
    this.ownerValue = owner;
    this.lastPhaseValue = phase;
    return enteredFinished;
  }

  /** The pill was hidden — nobody owns it. */
  noteHidden(): void {
    this.ownerValue = 'none';
    this.lastPhaseValue = null;
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
