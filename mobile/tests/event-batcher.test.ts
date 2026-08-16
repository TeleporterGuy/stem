import { describe, expect, it } from 'vitest';
import type { BackendEventEnvelope } from '@shared/types';
import { createEventBatcher, type Scheduler } from '../src/transport/eventBatcher';

const event = (method: string, params: unknown): BackendEventEnvelope => ({
  method,
  params,
  receivedAt: '2026-08-14T10:00:00.000Z'
});

const delta = (threadId: string, turnId: string, text: string): BackendEventEnvelope =>
  event('item/agentMessage/delta', { threadId, turnId, itemId: 'i1', delta: text });

/** A scheduler the test drives by hand, so no timer and no frame loop is involved. */
function manualScheduler(): { schedule: Scheduler; tick: () => void; pending: () => boolean } {
  let queued: (() => void) | null = null;
  return {
    schedule: (run) => {
      queued = run;
      return () => {
        queued = null;
      };
    },
    tick: () => {
      const run = queued;
      queued = null;
      run?.();
    },
    pending: () => queued !== null
  };
}

describe('createEventBatcher', () => {
  it('holds deltas until the tick, then applies one concatenated event', () => {
    const applied: BackendEventEnvelope[] = [];
    const clock = manualScheduler();
    const batcher = createEventBatcher((e) => applied.push(e), clock.schedule);

    batcher.push(delta('t1', 'u1', 'Hel'));
    batcher.push(delta('t1', 'u1', 'lo '));
    batcher.push(delta('t1', 'u1', 'there'));
    expect(applied).toHaveLength(0);

    clock.tick();
    expect(applied).toHaveLength(1);
    expect(applied[0].params).toMatchObject({ threadId: 't1', turnId: 'u1', delta: 'Hello there' });
  });

  it('flushes a thread before any other event on it, so ordering survives batching', () => {
    const applied: BackendEventEnvelope[] = [];
    const clock = manualScheduler();
    const batcher = createEventBatcher((e) => applied.push(e), clock.schedule);

    batcher.push(delta('t1', 'u1', 'answer'));
    batcher.push(event('turn/completed', { threadId: 't1', turn: { id: 'u1' } }));

    expect(applied.map((e) => e.method)).toEqual(['item/agentMessage/delta', 'turn/completed']);
    expect(applied[0].params).toMatchObject({ delta: 'answer' });
  });

  it('leaves another thread’s buffer alone when one thread settles', () => {
    const applied: BackendEventEnvelope[] = [];
    const clock = manualScheduler();
    const batcher = createEventBatcher((e) => applied.push(e), clock.schedule);

    batcher.push(delta('t1', 'u1', 'one'));
    batcher.push(delta('t2', 'u2', 'two'));
    batcher.push(event('turn/completed', { threadId: 't1', turn: { id: 'u1' } }));

    expect(applied).toHaveLength(2);
    clock.tick();
    expect(applied[2].params).toMatchObject({ threadId: 't2', delta: 'two' });
  });

  it('flushes the older turn first when a new one starts streaming mid-tick', () => {
    const applied: BackendEventEnvelope[] = [];
    const clock = manualScheduler();
    const batcher = createEventBatcher((e) => applied.push(e), clock.schedule);

    batcher.push(delta('t1', 'u1', 'first'));
    batcher.push(delta('t1', 'u2', 'second'));

    expect(applied).toHaveLength(1);
    expect(applied[0].params).toMatchObject({ turnId: 'u1', delta: 'first' });
    clock.tick();
    expect(applied[1].params).toMatchObject({ turnId: 'u2', delta: 'second' });
  });

  it('flushes everything on a thread-less event, which says something every buffer is behind on', () => {
    const applied: BackendEventEnvelope[] = [];
    const clock = manualScheduler();
    const batcher = createEventBatcher((e) => applied.push(e), clock.schedule);

    batcher.push(delta('t1', 'u1', 'a'));
    batcher.push(delta('t2', 'u2', 'b'));
    batcher.push(event('process/exit', {}));

    expect(applied.map((e) => e.method)).toEqual([
      'item/agentMessage/delta',
      'item/agentMessage/delta',
      'process/exit'
    ]);
    expect(clock.pending()).toBe(false);
  });

  it('flush() delivers buffered tokens and cancels the pending tick', () => {
    const applied: BackendEventEnvelope[] = [];
    const clock = manualScheduler();
    const batcher = createEventBatcher((e) => applied.push(e), clock.schedule);

    batcher.push(delta('t1', 'u1', 'tail'));
    batcher.flush();
    expect(applied).toHaveLength(1);
    expect(clock.pending()).toBe(false);

    // A tick that arrives anyway must not re-apply what flush() already did.
    clock.tick();
    expect(applied).toHaveLength(1);
  });
});
