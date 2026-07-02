import { describe, expect, it } from 'vitest';
import type { BackendEventEnvelope, MessageMeta, ThreadStatus } from '../../src/shared/types';
import {
  EMPTY_STATE,
  applyBackendEventToThread,
  applyProcessExitToThread,
  backendEventThreadId
} from '../../src/renderer/chatState';

function event(method: string, params: unknown): BackendEventEnvelope {
  return { method, params, receivedAt: '2026-06-23T00:00:00.000Z' };
}

describe('chatState reducer', () => {
  it('creates and appends streamed assistant deltas', () => {
    const first = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'Hel' })
    )!;
    const second = applyBackendEventToThread(
      first,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'lo' })
    )!;

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ id: 'assistant-turn1', role: 'assistant', content: 'Hello' });
    expect(second.running).toBe(true);
    expect(second.streamingId).toBe('assistant-turn1');
    expect(second.status).toBe('running');
  });

  it('uses completed agent text as authoritative and preserves metadata', () => {
    const meta = new Map<string, MessageMeta>([['turn1', { model: 'openai/test', effort: 'high' }]]);
    const streamed = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'draft' }),
      { turnMeta: meta }
    )!;
    const completed = applyBackendEventToThread(
      streamed,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'agentMessage', id: 'turn1', text: 'final' }
      }),
      { turnMeta: meta }
    )!;

    expect(completed.messages[0]).toMatchObject({ content: 'final', meta: { model: 'openai/test', effort: 'high' } });
    expect(completed.streamingId).toBeNull();
  });

  it('sets activity labels before text streams', () => {
    const next = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/started', { threadId: 't1', turnId: 'turn1', item: { type: 'webSearch', id: 'tool1' } })
    )!;

    expect(next.activity).toBe('Searching the web…');
  });

  it('clears running state for completed, failed, and aborted turns with caller status policy', () => {
    const running = { ...EMPTY_STATE, running: true, streamingId: 'assistant-turn1', activeTurnId: 'turn1', status: 'running' as const };
    const statusFor = (method: string): ThreadStatus => (method === 'turn/failed' ? 'error' : method === 'turn/completed' ? 'done' : 'idle');

    for (const method of ['turn/completed', 'turn/failed', 'turn/aborted'] as const) {
      const next = applyBackendEventToThread(
        running,
        event(method, { threadId: 't1', turn: { id: 'turn1', status: method.slice(5) } }),
        { settledStatus: (m) => statusFor(m) }
      )!;

      expect(next.running).toBe(false);
      expect(next.streamingId).toBeNull();
      expect(next.activity).toBeNull();
      expect(next.activeTurnId).toBeNull();
      expect(next.status).toBe(statusFor(method));
    }
  });

  it('supports main inactive completion and quick-chat idle completion policies', () => {
    const running = { ...EMPTY_STATE, running: true, activeTurnId: 'turn1', status: 'running' as const };
    const completed = event('turn/completed', { threadId: 'background', turn: { id: 'turn1', status: 'completed' } });

    const main = applyBackendEventToThread(running, completed, {
      settledStatus: (_method, threadId) => (threadId === 'active' ? 'idle' : 'done')
    })!;
    const quickChat = applyBackendEventToThread(running, completed, { settledStatus: () => 'idle' })!;

    expect(main.status).toBe('done');
    expect(quickChat.status).toBe('idle');
  });

  it('clears active run state on process exit without dropping existing error/done status', () => {
    const running = { ...EMPTY_STATE, running: true, streamingId: 'assistant-turn1', activity: 'Working…', activeTurnId: 'turn1', status: 'running' as const };
    const done = { ...EMPTY_STATE, status: 'done' as const };

    expect(applyProcessExitToThread(running)).toMatchObject({
      running: false,
      streamingId: null,
      activity: null,
      activeTurnId: null,
      status: 'idle'
    });
    expect(applyProcessExitToThread(done).status).toBe('done');
  });

  it('attaches per-turn usage to the assistant message', () => {
    const completed = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'agentMessage', id: 'turn1', text: 'hi' }
      })
    )!;
    const withUsage = applyBackendEventToThread(
      completed,
      event('turn/usage', {
        threadId: 't1',
        turnId: 'turn1',
        input: 26459,
        output: 1339,
        cacheRead: 1920,
        cacheWrite: 0,
        totalTokens: 29718,
        cost: 0.17
      })
    )!;

    expect(withUsage.messages[0].usage).toEqual({
      input: 26459,
      output: 1339,
      cacheRead: 1920,
      cacheWrite: 0,
      totalTokens: 29718,
      cost: 0.17
    });
  });

  it('ignores usage for a turn with no assistant bubble', () => {
    expect(
      applyBackendEventToThread(
        EMPTY_STATE,
        event('turn/usage', {
          threadId: 't1',
          turnId: 'missing',
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: null
        })
      )
    ).toBeNull();
  });

  it('extracts thread ids from event params', () => {
    expect(backendEventThreadId(event('turn/completed', { threadId: 't1' }))).toBe('t1');
    expect(backendEventThreadId(event('process/exit', { code: 1 }))).toBeUndefined();
  });

  it('accumulates activity rows, survives streaming, and stamps them onto the message at settle', () => {
    let s = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c1', name: 'read', detail: 'a.md' }
      })
    )!;
    expect(s.activities).toEqual([
      { id: 'c1', kind: 'tool', type: 'commandExecution', name: 'read', detail: 'a.md', status: 'running' }
    ]);

    // Text streaming clears the label but keeps (and stamps) the activity rows.
    s = applyBackendEventToThread(
      s,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'Hi' })
    )!;
    expect(s.activity).toBeNull();
    expect(s.activities).toHaveLength(1);
    expect(s.messages[0].activity).toHaveLength(1);

    // Tool completion flips the row's status (and can refresh the detail).
    s = applyBackendEventToThread(
      s,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c1', status: 'ok' }
      })
    )!;
    expect(s.activities[0].status).toBe('ok');

    // Turn settle stamps the final list on the bubble and clears live state.
    s = applyBackendEventToThread(s, event('turn/completed', { threadId: 't1', turn: { id: 'turn1', status: 'completed' } }))!;
    expect(s.activities).toHaveLength(0);
    expect(s.messages[0].activity).toHaveLength(1);
    expect(s.messages[0].activity![0].status).toBe('ok');
  });

  it('labels concurrent tool calls with a count and falls back as they finish', () => {
    // pi executes a turn's tool calls in parallel — two starts before any end.
    let s = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c1', name: 'read', detail: 'a.md' }
      })
    )!;
    expect(s.activity).toBe('Reading a.md…');

    s = applyBackendEventToThread(
      s,
      event('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c2', name: 'grep', detail: 'foo' }
      })
    )!;
    expect(s.activity).toBe('Running 2 tools…');

    // One finishes (out of order) — the label falls back to the still-running tool.
    s = applyBackendEventToThread(
      s,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c1', status: 'ok' }
      })
    )!;
    expect(s.activity).toBe('Searching for foo…');

    // Last one finishes — the label is kept until reasoning/answer overwrites it.
    s = applyBackendEventToThread(
      s,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c2', status: 'ok' }
      })
    )!;
    expect(s.activity).toBe('Searching for foo…');
    expect(s.activities.map((a) => a.status)).toEqual(['ok', 'ok']);
  });

  it('dedupes repeated item/started for the same tool call', () => {
    const started = event('item/started', {
      threadId: 't1',
      turnId: 'turn1',
      item: { type: 'webSearch', id: 'ws1', name: 'web_search', detail: 'weather' }
    });
    const once = applyBackendEventToThread(EMPTY_STATE, started)!;
    const twice = applyBackendEventToThread(once, started)!;
    expect(twice.activities).toHaveLength(1);
    expect(twice.activities[0].kind).toBe('webSearch');
  });

  it('attaches web sources to the turn message', () => {
    let s = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'Hi' })
    )!;
    s = applyBackendEventToThread(
      s,
      event('turn/sources', { threadId: 't1', turnId: 'turn1', sources: [{ url: 'https://example.com', title: 'Example' }] })
    )!;
    expect(s.messages[0].sources).toEqual([{ url: 'https://example.com', title: 'Example' }]);
  });
});
