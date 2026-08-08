import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPLETE_READY_TIMEOUT_MS,
  ensureCompleteModel,
  ensureCompleteThinking,
  promptComplete,
  resetCompleteConversation
} from '../../src/server/pi/complete-worker';
import type { PiProcess, PiResponse } from '../../src/server/pi/rpc';

// Hardened complete path: get_state / set_model / prompt ack + LLM wait after accept.

function mockChild(handlers: {
  request?: (command: Record<string, unknown>, timeoutMs?: number) => Promise<PiResponse>;
  stderr?: string;
}): PiProcess {
  const ee = new EventEmitter() as PiProcess & EventEmitter;
  ee.request = handlers.request ?? (async () => ({ type: 'response', command: 'x', success: true }));
  Object.defineProperty(ee, 'stderr', { get: () => handlers.stderr ?? '' });
  Object.defineProperty(ee, 'running', { get: () => true });
  return ee;
}

describe('resetCompleteConversation', () => {
  it('sends new_session so the next prompt starts clean', async () => {
    const request = vi.fn(async () => ({ type: 'response' as const, command: 'new_session', success: true }));
    const child = mockChild({ request });
    await expect(resetCompleteConversation(child)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith({ type: 'new_session' }, COMPLETE_READY_TIMEOUT_MS);
  });

  it('throws when pi will not reset — the caller must retire the worker', async () => {
    const child = mockChild({
      request: async () => ({
        type: 'response',
        command: 'new_session',
        success: false,
        error: 'sessions are disabled'
      })
    });
    await expect(resetCompleteConversation(child)).rejects.toThrow(/sessions are disabled/);
  });
});

describe('ensureCompleteThinking', () => {
  it('says nothing when no level was asked for', async () => {
    // The setting starts unset, which has to mean "leave it exactly where it was"
    // — a background job that suddenly reasoned differently after an upgrade
    // nobody configured would be the wrong kind of surprise.
    const request = vi.fn();
    const child = mockChild({ request });
    await expect(ensureCompleteThinking(child, null, null)).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('skips the RPC when the level is already in force', async () => {
    const request = vi.fn();
    const child = mockChild({ request });
    await expect(ensureCompleteThinking(child, 'low', 'low')).resolves.toBe('low');
    expect(request).not.toHaveBeenCalled();
  });

  it('applies the level and reports it as current', async () => {
    const request = vi.fn(async () => ({ type: 'response' as const, command: 'set_thinking_level', success: true }));
    const child = mockChild({ request });
    await expect(ensureCompleteThinking(child, 'low', 'high')).resolves.toBe('low');
    expect(request).toHaveBeenCalledWith(
      { type: 'set_thinking_level', level: 'low' },
      COMPLETE_READY_TIMEOUT_MS
    );
  });

  it('keeps the old level when pi refuses, instead of failing the job', async () => {
    // A model with no reasoning to configure still has to answer. The level was
    // an economy measure; losing it costs money, and throwing costs the memory.
    const child = mockChild({
      request: async () => ({ type: 'response', command: 'set_thinking_level', success: false, error: 'no reasoning' })
    });
    await expect(ensureCompleteThinking(child, 'low', 'medium')).resolves.toBe('medium');
  });

  it('survives a transport error the same way', async () => {
    const child = mockChild({ request: async () => { throw new Error('socket closed'); } });
    await expect(ensureCompleteThinking(child, 'low', null)).resolves.toBeNull();
  });
});

describe('ensureCompleteModel', () => {
  it('skips set_model when the key already matches', async () => {
    const request = vi.fn();
    const child = mockChild({ request });
    await expect(ensureCompleteModel(child, 'anthropic', 'haiku', 'anthropic/haiku')).resolves.toBe(
      'anthropic/haiku'
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('calls set_model and returns the new key', async () => {
    const request = vi.fn(async () => ({ type: 'response' as const, command: 'set_model', success: true }));
    const child = mockChild({ request });
    await expect(ensureCompleteModel(child, 'anthropic', 'haiku', null)).resolves.toBe('anthropic/haiku');
    expect(request).toHaveBeenCalledWith(
      { type: 'set_model', provider: 'anthropic', modelId: 'haiku' },
      COMPLETE_READY_TIMEOUT_MS
    );
  });

  it('throws when set_model is rejected', async () => {
    const child = mockChild({
      request: async () => ({
        type: 'response',
        command: 'set_model',
        success: false,
        error: 'unknown model'
      })
    });
    await expect(ensureCompleteModel(child, 'x', 'y', null)).rejects.toThrow(/unknown model/);
  });
});

describe('promptComplete', () => {
  it('fails fast when pi rejects the prompt (no silent wait)', async () => {
    const child = mockChild({
      request: async () => ({
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'Agent is already processing'
      })
    });
    await expect(promptComplete(child, 'classify this', 5_000)).rejects.toThrow(/already processing/);
  });

  it('budgets the prompt ack separately from the LLM wait', async () => {
    // The ack is local; giving it the LLM budget made the worst case two full
    // budgets back to back (a 60s judge blocking a tool call for 120s).
    const request = vi.fn(async (_command: Record<string, unknown>, _timeoutMs?: number) => ({
      type: 'response' as const,
      command: 'prompt',
      success: false
    }));
    const child = mockChild({ request });
    await expect(promptComplete(child, 'hi', 60_000)).rejects.toThrow();
    expect(request.mock.calls[0]?.[1]).toBe(COMPLETE_READY_TIMEOUT_MS);
  });

  it('returns assistant text after prompt accept + agent_end', async () => {
    const child = mockChild({
      request: async (cmd) => {
        expect(cmd.type).toBe('prompt');
        queueMicrotask(() => {
          child.emit('event', {
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: 'safe' }] }
          });
          child.emit('event', { type: 'agent_end' });
        });
        return { type: 'response', command: 'prompt', success: true };
      }
    });
    await expect(promptComplete(child, 'hi', 5_000)).resolves.toBe('safe');
  });

  it('throws empty-complete when agent_end has no text', async () => {
    const child = mockChild({
      stderr: 'Model not found\n',
      request: async () => {
        queueMicrotask(() => child.emit('event', { type: 'agent_end' }));
        return { type: 'response', command: 'prompt', success: true };
      }
    });
    await expect(promptComplete(child, 'hi', 5_000)).rejects.toThrow(/no text/);
  });

  // Note this covers the transport only — the child keeps one conversation, so
  // real reuse must call resetCompleteConversation() between prompts.
  it('can run two prompts on the same child (warm reuse)', async () => {
    let n = 0;
    const child = mockChild({
      request: async () => {
        n += 1;
        const label = `ok${n}`;
        queueMicrotask(() => {
          child.emit('event', {
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: label }] }
          });
          child.emit('event', { type: 'agent_end' });
        });
        return { type: 'response', command: 'prompt', success: true };
      }
    });
    await expect(promptComplete(child, 'a', 5_000)).resolves.toBe('ok1');
    await expect(promptComplete(child, 'b', 5_000)).resolves.toBe('ok2');
  });
});
