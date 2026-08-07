import { describe, expect, it } from 'vitest';
import type { PiEvent } from '../../src/server/pi/rpc';
import { newTurnContext, normalizePiEvent, toolCallActivity } from '../../src/server/pi/normalize';

const ev = (o: Record<string, unknown>): PiEvent => o as unknown as PiEvent;

describe('normalize tool activity', () => {
  it('tracks a tool call from start to successful end', () => {
    const ctx = newTurnContext('t1', 'turn1');
    const start = normalizePiEvent(
      ev({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', toolInput: { path: '/a/b/notes.md' } }),
      ctx
    );
    expect(start.events[0]).toMatchObject({
      method: 'item/started',
      params: { item: { type: 'commandExecution', id: 'c1', name: 'read', detail: 'notes.md' } }
    });
    expect(ctx.activity).toEqual([
      { id: 'c1', kind: 'tool', type: 'commandExecution', name: 'read', detail: 'notes.md', status: 'running' }
    ]);

    const end = normalizePiEvent(ev({ type: 'tool_execution_end', toolCallId: 'c1', isError: false }), ctx);
    expect(end.events[0]).toMatchObject({
      method: 'item/completed',
      params: { item: { id: 'c1', status: 'ok' } }
    });
    expect(ctx.activity[0].status).toBe('ok');
  });

  // A turn's toolMs is one number for the whole turn: two minutes in tools looks
  // identical whether it was one slow web search or forty fast file reads. That
  // ambiguity is how a ~10x search-latency regression shipped unnoticed, so every
  // settled tool carries its own duration — see tests/unit/web-search-latency.test.ts.
  it('stamps each tool call with the time it took', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(ev({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'web_search' }), ctx);
    expect(ctx.activity[0].ms).toBeUndefined(); // still running — no duration yet
    normalizePiEvent(ev({ type: 'tool_execution_end', toolCallId: 'c1', isError: false }), ctx);
    expect(ctx.activity[0].ms).toBeGreaterThanOrEqual(0);
  });

  it('attributes time per tool, not per turn', () => {
    const ctx = newTurnContext('t1', 'turn1');
    for (const id of ['c1', 'c2']) {
      normalizePiEvent(ev({ type: 'tool_execution_start', toolCallId: id, toolName: 'read' }), ctx);
    }
    // Out-of-order completion must not cross the wires.
    normalizePiEvent(ev({ type: 'tool_execution_end', toolCallId: 'c2', isError: false }), ctx);
    expect(ctx.activity[0].ms).toBeUndefined();
    expect(ctx.activity[1].ms).toBeGreaterThanOrEqual(0);
  });

  it('flags an errored tool end', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(ev({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', toolInput: { command: 'ls' } }), ctx);
    normalizePiEvent(ev({ type: 'tool_execution_end', toolCallId: 'c1', isError: true }), ctx);
    expect(ctx.activity[0].status).toBe('error');
  });

  it('ignores a tool end without a tracked start', () => {
    const ctx = newTurnContext('t1', 'turn1');
    const end = normalizePiEvent(ev({ type: 'tool_execution_end', toolCallId: 'nope' }), ctx);
    expect(end.events).toHaveLength(0);
  });

  it('unwraps invoke_tool into the real tool for the activity row', () => {
    const item = toolCallActivity('c2', 'invoke_tool', {
      server: 'slack',
      tool: 'search_messages',
      args: { query: 'deploy failure' }
    });
    expect(item).toMatchObject({
      id: 'c2',
      name: 'search_messages',
      type: 'webSearch', // name contains 'search'
      kind: 'webSearch',
      detail: 'deploy failure',
      status: 'running'
    });
  });

  it('classifies file edits as fileChange', () => {
    const item = toolCallActivity('c3', 'edit', { path: '/x/y/z.ts' });
    expect(item).toMatchObject({ type: 'fileChange', kind: 'tool', detail: 'z.ts' });
  });
});

describe('normalize compaction activity', () => {
  it('tracks a mid-run compaction from start to successful end', () => {
    const ctx = newTurnContext('t1', 'turn1');
    const start = normalizePiEvent(ev({ type: 'compaction_start', reason: 'overflow' }), ctx);
    expect(start.events[0]).toMatchObject({
      method: 'item/started',
      params: { item: { type: 'compaction', id: 'compaction-turn1-0' } }
    });
    expect(ctx.activity).toEqual([{ id: 'compaction-turn1-0', kind: 'tool', type: 'compaction', status: 'running' }]);

    const end = normalizePiEvent(ev({ type: 'compaction_end', reason: 'overflow', aborted: false, result: {} }), ctx);
    expect(end.events[0]).toMatchObject({
      method: 'item/completed',
      params: { item: { type: 'compaction', id: 'compaction-turn1-0', status: 'ok' } }
    });
    expect(ctx.activity[0].status).toBe('ok');
  });

  it('flags a failed compaction end', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(ev({ type: 'compaction_start', reason: 'overflow' }), ctx);
    normalizePiEvent(
      ev({ type: 'compaction_end', reason: 'overflow', aborted: false, errorMessage: 'recovery failed' }),
      ctx
    );
    expect(ctx.activity[0].status).toBe('error');
  });

  it('ignores a compaction end without a tracked start', () => {
    const ctx = newTurnContext('t1', 'turn1');
    const end = normalizePiEvent(ev({ type: 'compaction_end', reason: 'threshold', aborted: false }), ctx);
    expect(end.events).toHaveLength(0);
  });
});

describe('normalize turn outcome', () => {
  const assistantEnd = (msg: Record<string, unknown>) =>
    ev({ type: 'message_end', message: { role: 'assistant', ...msg } });

  it('fails the turn when the last assistant message errored', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(assistantEnd({ content: [], stopReason: 'error', errorMessage: 'fetch failed' }), ctx);
    const end = normalizePiEvent(ev({ type: 'agent_end' }), ctx);
    expect(end.events.at(-1)).toMatchObject({
      method: 'turn/failed',
      params: { error: 'fetch failed' }
    });
  });

  it('completes the turn when pi recovers from an errored message within the run', () => {
    // pi retries transient failures (fetch failed / context overflow + compaction)
    // inside one agent run — the turn's outcome is its LAST message, not its worst.
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(assistantEnd({ content: [], stopReason: 'error', errorMessage: 'fetch failed' }), ctx);
    normalizePiEvent(assistantEnd({ content: [{ type: 'text', text: 'answer' }], stopReason: 'stop' }), ctx);
    const end = normalizePiEvent(ev({ type: 'agent_end' }), ctx);
    expect(end.events.at(-1)).toMatchObject({ method: 'turn/completed' });
  });

  it('keeps an abort latched even if a later message ends cleanly', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(assistantEnd({ content: [], stopReason: 'aborted' }), ctx);
    normalizePiEvent(assistantEnd({ content: [{ type: 'text', text: 'late' }], stopReason: 'stop' }), ctx);
    const end = normalizePiEvent(ev({ type: 'agent_end' }), ctx);
    expect(end.events.at(-1)).toMatchObject({ method: 'turn/aborted' });
  });

  it('keeps the turn open when agent_end announces an auto-retry (willRetry)', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(assistantEnd({ content: [], stopReason: 'error', errorMessage: 'overloaded' }), ctx);
    const end = normalizePiEvent(ev({ type: 'agent_end', willRetry: true }), ctx);
    expect(end.done).toBe(false);
    expect(end.events).toHaveLength(0);
    // The retry continuation succeeds inside the SAME turn → completed, not failed.
    normalizePiEvent(assistantEnd({ content: [{ type: 'text', text: 'answer' }], stopReason: 'stop' }), ctx);
    const settled = normalizePiEvent(ev({ type: 'agent_end' }), ctx);
    expect(settled.done).toBe(true);
    expect(settled.events.at(-1)).toMatchObject({ method: 'turn/completed' });
  });

  it('willRetry never holds open an aborted turn', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(assistantEnd({ content: [], stopReason: 'aborted' }), ctx);
    const end = normalizePiEvent(ev({ type: 'agent_end', willRetry: true }), ctx);
    expect(end.done).toBe(true);
    expect(end.events.at(-1)).toMatchObject({ method: 'turn/aborted' });
  });
});

// The renderer keys ONE bubble per turn (`assistant-${turnId}`) and an
// item/completed replaces its content, so whatever the last assistant message of a
// turn says is what the user is left looking at. A turn routinely holds more than
// one: the web-access extension nudges a fresh message (sendMessage triggerTurn)
// when a background URL fetch lands, sometimes after the answer is already written.
// A real reply — a microwave comparison with prices and a verdict — was replaced on
// screen by a trailing "so the Beko is the best buy" one-liner because of this.
describe('normalize: several assistant messages in one turn', () => {
  const delta = (text: string) =>
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  const assistantEnd = (text: string, stopReason = 'stop') =>
    ev({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text }], stopReason }
    });
  const completedTexts = (events: { method: string; params: unknown }[]) =>
    events
      .filter((e) => e.method === 'item/completed')
      .map((e) => ((e.params as { item: { text?: string } }).item.text ?? ''));

  it('joins them into one reply instead of letting the last one replace it', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(delta('## Odporúčam Beko'), ctx);
    const first = normalizePiEvent(assistantEnd('## Odporúčam Beko'), ctx);
    expect(completedTexts(first.events)).toEqual(['## Odporúčam Beko']);

    const second = normalizePiEvent(assistantEnd('Beko je najlepšia kúpa.'), ctx);
    expect(completedTexts(second.events)).toEqual(['## Odporúčam Beko\n\nBeko je najlepšia kúpa.']);
    expect(ctx.assistantText).toBe('## Odporúčam Beko\n\nBeko je najlepšia kúpa.');
  });

  it('separates them in the delta stream too, so the live bubble matches', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(delta('first'), ctx);
    normalizePiEvent(assistantEnd('first'), ctx);
    const next = normalizePiEvent(delta('second'), ctx);
    expect(next.events[0]).toMatchObject({
      method: 'item/agentMessage/delta',
      params: { delta: '\n\nsecond' }
    });
    expect(ctx.assistantText).toBe('first\n\nsecond');
  });

  // A message that stops on a tool call carries no text; the separator has to wait
  // for the next message that actually says something.
  it('holds the separator across a text-less tool-call message', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(delta('checking'), ctx);
    normalizePiEvent(assistantEnd('checking', 'toolUse'), ctx);
    normalizePiEvent(assistantEnd('', 'toolUse'), ctx);
    normalizePiEvent(delta('done'), ctx);
    expect(ctx.assistantText).toBe('checking\n\ndone');
  });

  // pi retries a failed message inside the same run by REPLAYING the whole reply.
  // The partial must not survive as a committed prefix for the replay to append to.
  it('replaces rather than joins when pi retries a failed message', () => {
    const ctx = newTurnContext('t1', 'turn1');
    normalizePiEvent(delta('half an ans'), ctx);
    normalizePiEvent(assistantEnd('half an ans', 'error'), ctx);
    const retry = normalizePiEvent(assistantEnd('the whole answer'), ctx);
    expect(completedTexts(retry.events)).toEqual(['the whole answer']);
    expect(ctx.assistantText).toBe('the whole answer');
  });
});
