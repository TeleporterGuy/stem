// Real tok/s: each model call is timed off pi's stream events with its exact
// output tokens, and the turn sums both, so a tool turn gets a speed and a
// model's silent thinking is clocked with the tokens it produced.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { newGenerationClock, trackGeneration, type GenerationClock } from '../../src/server/pi/generation-speed';
import { newTurnContext } from '../../src/server/pi/normalize';
import { PiRuntime } from '../../src/server/pi/runtime';
import { RecallStore } from '../../src/server/recall/store';
import { applyBackendEventToThread, EMPTY_STATE, type ThreadState } from '../../src/shared/chatState';

const dir = mkdtempSync(join(tmpdir(), 'stem-generation-speed-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

type Usage = { output: number; reasoning?: number };
const start = (clock: GenerationClock, at: number, role = 'assistant') =>
  trackGeneration(clock, { type: 'message_start', message: { role } }, at);
const delta = (clock: GenerationClock, at: number, type = 'text_delta') =>
  trackGeneration(clock, { type: 'message_update', assistantMessageEvent: { type, delta: 'x' } }, at);
const end = (clock: GenerationClock, at: number, usage: Usage, stopReason = 'stop') =>
  trackGeneration(clock, { type: 'message_end', message: { role: 'assistant', stopReason, usage } }, at);

describe('generation clock', () => {
  it('sums a tool turn call by call, first token to end, leaving tool time out', () => {
    const clock = newGenerationClock();
    start(clock, 0);
    delta(clock, 400, 'toolcall_start'); // no tokens yet
    delta(clock, 500, 'toolcall_delta');
    end(clock, 1500, { output: 100 }, 'toolUse');
    // The tool runs from 1500 to 5000; the next call's TTFT runs to 5600.
    start(clock, 5000);
    delta(clock, 5600);
    end(clock, 7600, { output: 300 });
    expect(clock).toMatchObject({ tokens: 400, ms: 3000 });
  });

  it('clocks a call that reports reasoning tokens from its stream open', () => {
    const clock = newGenerationClock();
    start(clock, 0);
    delta(clock, 8000);
    end(clock, 10_000, { output: 1000, reasoning: 800 });
    expect(clock).toMatchObject({ tokens: 1000, ms: 10_000 });
  });

  it('skips failed and burst-delivered calls, and ignores the user message', () => {
    const clock = newGenerationClock();
    start(clock, 0);
    delta(clock, 100);
    end(clock, 900, { output: 50 }, 'error');
    start(clock, 1000);
    start(clock, 1100, 'user'); // must not move the open call's clock
    delta(clock, 1200);
    end(clock, 1200, { output: 40 }); // first token and end in one burst
    expect(clock).toMatchObject({ tokens: 0, ms: 0 });
  });
});

describe('generation speed in the runtime', () => {
  it("a tool turn's turn/timing carries its calls' tokens and stream time", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const piHome = join(dir, 'runtime', 'pi');
    mkdirSync(join(piHome, 'sessions'), { recursive: true });
    mkdirSync(join(dir, 'runtime', 'workspace'), { recursive: true });
    const runtime = new PiRuntime({
      piHome,
      sessionsDir: join(piHome, 'sessions'),
      workspaceRoot: join(dir, 'runtime', 'workspace'),
      seedGlobalAuth: false
    });
    const timings: Array<Record<string, unknown>> = [];
    runtime.on('event', (e: { method: string; params?: unknown }) => {
      if (e.method === 'turn/timing') timings.push(e.params as Record<string, unknown>);
    });
    const internal = runtime as unknown as {
      primaryWorker(): { currentTurn: unknown; proc: null };
      onPiEvent: (worker: unknown, event: Record<string, unknown>) => void;
    };
    const worker = internal.primaryWorker();
    const turn = newTurnContext('thread', 'turn');
    turn.startedAt = 0;
    worker.currentTurn = turn;
    const at = (ms: number, event: Record<string, unknown>) => {
      vi.setSystemTime(ms);
      internal.onPiEvent(worker, event);
    };
    const assistant = (usage?: Record<string, number>, stopReason?: string) => ({
      role: 'assistant', content: [], ...(usage ? { usage } : {}), ...(stopReason ? { stopReason } : {})
    });
    at(0, { type: 'message_start', message: assistant() });
    at(500, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{' } });
    at(1500, { type: 'message_end', message: assistant({ output: 100 }, 'toolUse') });
    at(1500, { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'c1', args: { command: 'ls' } });
    at(5000, { type: 'tool_execution_end', toolName: 'bash', toolCallId: 'c1', result: { content: [] } });
    at(5000, { type: 'message_start', message: assistant() });
    at(5600, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done.' } });
    at(7600, { type: 'message_end', message: assistant({ output: 300 }, 'stop') });
    at(7700, { type: 'agent_end' });
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ outputTokens: 400, generationMs: 3000 });
  });
});

describe('generation speed persistence', () => {
  it('round-trips through turn_timings, and older rows come back without it', () => {
    const store = new RecallStore(() => join(dir, 'fresh.sqlite'));
    try {
      const base = { threadId: 't', totalMs: 9000, thinkingMs: 0, toolMs: 3500, answerMs: 2000, ttftMs: 600, buildMs: 20, recallMs: 10 };
      store.upsertTurnTiming({ turnEntryId: 'u1', ...base, outputTokens: 400, generationMs: 3000 });
      store.upsertTurnTiming({ turnEntryId: 'u2', ...base });
      const rows = store.getTurnTimingsByThread('t');
      expect(rows.get('u1')).toMatchObject({ outputTokens: 400, generationMs: 3000 });
      expect(rows.get('u2')).not.toHaveProperty('outputTokens');
      expect(rows.get('u2')).not.toHaveProperty('generationMs');
    } finally {
      store.close();
    }
  });

  it('adds the columns to a turn_timings table created before them', () => {
    const path = join(dir, 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE turn_timings (
      turn_entry_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, total_ms INTEGER,
      thinking_ms INTEGER NOT NULL, tool_ms INTEGER NOT NULL, answer_ms INTEGER NOT NULL,
      ttft_ms INTEGER, build_ms INTEGER, recall_ms INTEGER, created_at INTEGER NOT NULL)`);
    old.prepare(`INSERT INTO turn_timings VALUES ('u0', 't', 1000, 0, 0, 800, 200, NULL, NULL, 0)`).run();
    old.close();
    const store = new RecallStore(() => path);
    try {
      store.upsertTurnTiming({
        turnEntryId: 'u1', threadId: 't', totalMs: 1000, thinkingMs: 0, toolMs: 0, answerMs: 800,
        ttftMs: 200, buildMs: null, recallMs: null, outputTokens: 80, generationMs: 800
      });
      const rows = store.getTurnTimingsByThread('t');
      expect(rows.get('u0')).toMatchObject({ answerMs: 800 });
      expect(rows.get('u0')).not.toHaveProperty('outputTokens');
      expect(rows.get('u1')).toMatchObject({ outputTokens: 80, generationMs: 800 });
    } finally {
      store.close();
    }
  });

  it('a live turn/timing carries the measurement onto the bubble', () => {
    const state: ThreadState = { ...EMPTY_STATE, messages: [{ id: 'assistant-t1', role: 'assistant', content: 'Done.' }] };
    const params = {
      threadId: 'th', turnId: 't1', ensureMs: 0, buildMs: null, recall: { total: null },
      thinkingMs: 0, toolMs: 3500, answerMs: 2000, sendToFirstActivityMs: null,
      sendToFirstTokenMs: null, firstTokenToEndMs: null, totalMs: 9000
    };
    const measured = applyBackendEventToThread(state, { method: 'turn/timing', params: { ...params, outputTokens: 400, generationMs: 3000 } } as never)!;
    expect(measured.messages[0].timing).toMatchObject({ outputTokens: 400, generationMs: 3000 });
    const unmeasured = applyBackendEventToThread(state, { method: 'turn/timing', params: { ...params, outputTokens: null, generationMs: null } } as never)!;
    expect(unmeasured.messages[0].timing).not.toHaveProperty('outputTokens');
  });
});
