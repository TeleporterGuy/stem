// A phone backgrounded mid-send loses startTurn's answer though the server ran
// the turn; its resend carries the same turn id and must not start a second chat.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStartTurnOnce, startTurnOnce } from '../../src/server/start-turn-once';

describe('startTurnOnce', () => {
  beforeEach(() => resetStartTurnOnce());

  it('answers a resent turn id with the turn already started', async () => {
    const start = vi.fn().mockResolvedValueOnce({ threadId: 't1', turnId: 'a' }).mockResolvedValueOnce({ threadId: 't2', turnId: 'a' });
    expect(await startTurnOnce('a', start)).toEqual({ threadId: 't1', turnId: 'a' });
    expect(await startTurnOnce('a', start)).toEqual({ threadId: 't1', turnId: 'a' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('joins a resend that arrives while the first start is still running', async () => {
    let finish!: (v: { threadId: string }) => void;
    const start = vi.fn(() => new Promise<{ threadId: string }>((r) => (finish = r)));
    const first = startTurnOnce('a', start);
    const second = startTurnOnce('a', start);
    finish({ threadId: 't1' });
    expect(await second).toEqual({ threadId: 't1' });
    expect(await first).toEqual({ threadId: 't1' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('runs a retry for real when the first start threw', async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({ threadId: 't1' });
    await expect(startTurnOnce('a', start)).rejects.toThrow('busy');
    expect(await startTurnOnce('a', start)).toEqual({ threadId: 't1' });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('starts every call without a turn id, and forgets ids after ten minutes', async () => {
    const start = vi.fn().mockResolvedValue({ threadId: 't' });
    await startTurnOnce(undefined, start);
    await startTurnOnce(undefined, start);
    let now = 0;
    await startTurnOnce('a', start, () => now);
    now = 11 * 60_000;
    await startTurnOnce('a', start, () => now);
    expect(start).toHaveBeenCalledTimes(4);
  });
});
