import { describe, expect, it } from 'vitest';
import type { PiEvent } from '../../src/main/pi/rpc';
import { newTurnContext, normalizePiEvent, toolCallActivity } from '../../src/main/pi/normalize';

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
