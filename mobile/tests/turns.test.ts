// What a send comes back as, and what Stop does about it.
//
// The two answers `backend:startTurn` can give are a turn and a fait accompli,
// and only the first of them produces any events. A client that treats the
// second as the first sits there running: a Stop button over a thread nothing is
// happening in, and — because Stop then looks for the newest turn id it can find
// — a request that interrupts some earlier turn, or nothing at all, without
// saying so.

import { describe, expect, it } from 'vitest';
import { EMPTY_STATE, type ThreadState } from '@shared/chatState';
import type { ChatMessage } from '@shared/types';
import { applyStartTurnResult, interruptTarget } from '../src/chat/turns';

/** The optimistic half of a send, exactly as ../src/hooks/useThread.ts writes it. */
function sent(prev: ThreadState, id: string, content: string): ThreadState {
  const message: ChatMessage = { id, role: 'user', content };
  return { ...prev, messages: [...prev.messages, message], running: true, status: 'running' };
}

const text = (messages: ChatMessage[]): [string, string][] =>
  messages.map((m) => [m.role, m.content] as [string, string]);

describe('applyStartTurnResult', () => {
  it('stamps the turn id onto the bubble that started it', () => {
    const before = sent(EMPTY_STATE, 'u-1', 'what is the time?');
    const { state, turnId } = applyStartTurnResult(before, { turnId: 't-9' }, 'u-1');

    expect(turnId).toBe('t-9');
    expect(state.messages[0].turnId).toBe('t-9');
    // Still running: the turn is real and its events are on their way.
    expect(state.running).toBe(true);
  });

  it('ends a turn the server handled by itself, and shows what it said', () => {
    // The memory-capture path: no turn is started, so no event will ever arrive
    // to clear the optimistic `running` the composer is showing a Stop over.
    const before = sent(EMPTY_STATE, 'u-1', 'remember that I like oat milk');
    const { state, turnId } = applyStartTurnResult(
      before,
      { handled: true, assistantMessage: "I'll remember that." },
      'u-1'
    );

    expect(turnId).toBeNull();
    expect(text(state.messages)).toEqual([
      ['user', 'remember that I like oat milk'],
      ['assistant', "I'll remember that."]
    ]);
    expect(state.running).toBe(false);
    expect(state.activeTurnId).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('settles a handled send that had nothing to say', () => {
    const before = sent(EMPTY_STATE, 'u-1', 'never mind');
    const { state } = applyStartTurnResult(before, { handled: true }, 'u-1');

    expect(text(state.messages)).toEqual([['user', 'never mind']]);
    expect(state.running).toBe(false);
    expect(state.status).toBe('idle');
  });
});

describe('interruptTarget', () => {
  it('interrupts the turn the stream says is active', () => {
    expect(interruptTarget({ ...EMPTY_STATE, running: true, activeTurnId: 't-9' })).toBe('t-9');
  });

  it('falls back to the id stamped on the message, for a turn with no events yet', () => {
    // Between "startTurn answered" and the model's first move there is no active
    // turn, and on a slow provider that gap is exactly when Stop gets pressed.
    const started = applyStartTurnResult(sent(EMPTY_STATE, 'u-1', 'go'), { turnId: 't-9' }, 'u-1');
    expect(interruptTarget(started.state)).toBe('t-9');
  });

  it('has nothing to interrupt once a handled send has settled the thread', () => {
    // The bug this pins: after a real turn and then a handled one, the newest
    // stamped id belongs to a turn that finished long ago. Interrupting it would
    // be a round trip that changes nothing while the user waits for it to.
    const first = applyStartTurnResult(sent(EMPTY_STATE, 'u-1', 'go'), { turnId: 't-1' }, 'u-1');
    const settled: ThreadState = { ...first.state, running: false, activeTurnId: null, status: 'idle' };
    const second = applyStartTurnResult(
      sent(settled, 'u-2', 'remember that I like oat milk'),
      { handled: true, assistantMessage: "I'll remember that." },
      'u-2'
    );

    expect(second.state.running).toBe(false);
    expect(interruptTarget(second.state)).toBeNull();
  });
});
