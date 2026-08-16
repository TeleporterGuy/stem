// The turn trace is the raw material for skill authoring. Everything it captures
// was already flowing through the normalizer and being thrown away: `activity`
// keeps a display label (paths shrink to a basename) and drops results entirely,
// which is why the old distiller had to reconstruct procedures from the
// assistant's narration of them.
//
// These cases pin what is kept, what is deliberately dropped, and — most
// importantly — that a turn cannot grow the trace without bound.
import { describe, expect, it } from 'vitest';
import type { PiEvent } from '../../src/server/pi/rpc';
import {
  TRACE_ARGS_MAX_CHARS,
  TRACE_RESULT_MAX_CHARS,
  TRACE_TURN_MAX_CHARS,
  newTurnContext,
  normalizePiEvent,
  snapshotTurnTrace
} from '../../src/server/pi/normalize';
import { SECRET_ENVELOPE_KEY } from '../../src/server/pi/protocol';

const ev = (o: Record<string, unknown>): PiEvent => o as unknown as PiEvent;

function textResult(text: string, isError = false) {
  return { isError, content: [{ type: 'text', text }] };
}

function call(ctx: ReturnType<typeof newTurnContext>, id: string, name: string, args?: unknown, result?: unknown) {
  normalizePiEvent(ev({ type: 'tool_execution_start', toolCallId: id, toolName: name, toolInput: args }), ctx);
  if (result !== undefined) normalizePiEvent(ev({ type: 'tool_execution_end', toolCallId: id, result }), ctx);
}

describe('turn trace capture', () => {
  it('keeps the full argument, not the display basename', () => {
    const ctx = newTurnContext('t1', 'turn1');
    call(ctx, 'c1', 'read', { path: '/Users/x/files/Recipes/cake.pdf' }, textResult('Flour, sugar.'));

    // The activity row is a label; the trace is the evidence.
    expect(ctx.activity[0].detail).toBe('cake.pdf');
    expect(ctx.trace[0].args).toContain('/Users/x/files/Recipes/cake.pdf');
    expect(ctx.trace[0].result).toBe('Flour, sugar.');
    expect(ctx.trace[0].isError).toBe(false);
  });

  it('unwraps the MCP router meta-tool so the real tool is named', () => {
    const ctx = newTurnContext('t1', 'turn1');
    call(ctx, 'c1', 'invoke_tool', { tool: 'search_email', server: 'fastmail', args: { query: 'invoice' } });
    expect(ctx.trace[0].name).toBe('search_email');
  });

  it('records the error flag and the failure text', () => {
    const ctx = newTurnContext('t1', 'turn1');
    call(ctx, 'c1', 'run_command', { command: 'agent-browser open x' }, textResult('command not found', true));
    expect(ctx.trace[0].isError).toBe(true);
    expect(ctx.trace[0].result).toContain('command not found');
  });

  it('redacts credential values but keeps the shape of the call', () => {
    // add_mcp_server takes the user's token as a plain tool argument, and this
    // trace is fed to a model when a skill is authored. "Set MCP_TOKEN in env" is
    // the reusable part; the token itself never is.
    const ctx = newTurnContext('t1', 'turn1');
    call(ctx, 'c1', 'add_mcp_server', {
      name: 'ha',
      command: 'uvx ha-mcp@latest',
      env: { HA_TOKEN: 'eyJhbGciOi-real-token' },
      headers: { Authorization: 'Bearer sk-live-1234' },
      oauthClientSecret: 'shhh'
    });
    const args = ctx.trace[0].args!;
    expect(args).not.toContain('eyJhbGciOi-real-token');
    expect(args).not.toContain('sk-live-1234');
    expect(args).not.toContain('shhh');
    // The keys survive, so the procedure is still legible.
    expect(args).toContain('HA_TOKEN');
    expect(args).toContain('uvx ha-mcp@latest');
  });

  it('drops arguments carrying an encrypted secret envelope', () => {
    // The envelope check is the backstop for a ciphertext under a key the
    // name-based redaction has no reason to suspect. A truncated ciphertext is no
    // safer than a whole one, so the whole args object goes.
    const ctx = newTurnContext('t1', 'turn1');
    call(ctx, 'c1', 'add_mcp_server', { name: 'ha', config: { [SECRET_ENVELOPE_KEY]: 'deadbeef' } });
    expect(ctx.trace[0].args).toBeUndefined();
    expect(ctx.trace[0].name).toBe('add_mcp_server');
  });

  it('truncates a long argument and a long result', () => {
    const ctx = newTurnContext('t1', 'turn1');
    call(ctx, 'c1', 'read', { path: 'x'.repeat(5_000) }, textResult('y'.repeat(50_000)));
    expect(ctx.trace[0].args!.length).toBeLessThan(TRACE_ARGS_MAX_CHARS + 40);
    expect(ctx.trace[0].result!.length).toBeLessThan(TRACE_RESULT_MAX_CHARS + 40);
  });
});

describe('turn trace budget', () => {
  it('stops retaining payloads past the per-turn ceiling but keeps counting calls', () => {
    const ctx = newTurnContext('t1', 'turn1');
    // Enough successful calls to blow the ceiling several times over.
    for (let i = 0; i < 60; i += 1) {
      call(ctx, `c${i}`, 'read', { path: `/f/${i}` }, textResult('z'.repeat(TRACE_RESULT_MAX_CHARS)));
    }
    expect(ctx.trace).toHaveLength(60); // the gate counts these
    expect(ctx.traceChars).toBeLessThan(TRACE_TURN_MAX_CHARS + TRACE_RESULT_MAX_CHARS * 2);
    expect(ctx.trace.at(-1)!.result).toBeUndefined(); // payload dropped, entry kept
  });

  it('still keeps failures once the budget is spent', () => {
    const ctx = newTurnContext('t1', 'turn1');
    for (let i = 0; i < 60; i += 1) {
      call(ctx, `c${i}`, 'read', { path: `/f/${i}` }, textResult('z'.repeat(TRACE_RESULT_MAX_CHARS)));
    }
    call(ctx, 'boom', 'run_command', { command: 'x' }, textResult('permission denied', true));
    // A failure is what turns a list of steps into a warning about the dead end,
    // so it outranks the budget.
    expect(ctx.trace.at(-1)!.result).toContain('permission denied');
  });
});

describe('snapshotTurnTrace', () => {
  it('carries the flags authoring has to respect', () => {
    const ctx = newTurnContext('t1', 'turn1');
    ctx.userText = 'find the captions';
    ctx.assistantText = 'Here they are.';
    ctx.memoryTainted = true;
    ctx.isScheduled = true;
    ctx.skillsInjected = [
      { slug: 'extract-video-captions', name: 'extract-video-captions', description: 'captions', body: '## Steps\n1. x' }
    ];
    ctx.skillsGradedUsed = ['extract-video-captions'];
    call(ctx, 'c1', 'read', { path: '/a' }, textResult('ok'));

    const snap = snapshotTurnTrace(ctx, 1_000);
    expect(snap).toMatchObject({
      threadId: 't1',
      turnId: 'turn1',
      endedAt: 1_000,
      userText: 'find the captions',
      assistantText: 'Here they are.',
      memoryTainted: true,
      isScheduled: true,
      skillsInjected: ['extract-video-captions'],
      skillsGradedUsed: ['extract-video-captions']
    });
    expect(snap.trace).toHaveLength(1);
  });

  it('carries the injected skills even when none of them graded used', () => {
    // The two sets are not the same question and the snapshot must not conflate
    // them: injected is what retrieval offered, graded is what the turn followed.
    // A turn that ignored both still needs the offered slugs — that is the list
    // the author is shown so it can recognize "this already exists".
    const ctx = newTurnContext('t1', 'turn1');
    ctx.skillsInjected = [
      { slug: 'a-skill', name: 'a-skill', description: 'a', body: 'x' },
      { slug: 'b-skill', name: 'b-skill', description: 'b', body: 'y' }
    ];
    const snap = snapshotTurnTrace(ctx, 1);
    expect(snap.skillsInjected).toEqual(['a-skill', 'b-skill']);
    expect(snap.skillsGradedUsed).toEqual([]);
  });
});
