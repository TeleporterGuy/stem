// Background-activity registry — the model behind the toolbar indicator. The
// interesting behaviour is what does NOT get recorded (no-op passes) and how a
// stepped job that yields and resumes stays one entry with honest working time,
// since wall-clock would report an overnight rebuild as eight hours of work.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as activity from '../../src/server/activity';
import type { ActivitySnapshot } from '../../src/shared/types';

beforeEach(() => {
  vi.useFakeTimers();
  activity.resetActivity();
});

afterEach(() => {
  activity.setActivityEmitter(null);
  activity.resetActivity();
  vi.useRealTimers();
});

describe('activity registry', () => {
  it('drops runs that did nothing, keeps runs that did', () => {
    const idle = activity.begin('folders.scan', 'Scanning Notes');
    activity.end(idle, { worked: false });
    expect(activity.snapshot().history).toHaveLength(0);
    expect(activity.snapshot().running).toHaveLength(0);

    const busy = activity.begin('folders.scan', 'Scanning Notes');
    activity.end(busy, { worked: true, detail: '12 indexed' });
    const { history } = activity.snapshot();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ state: 'done', detail: '12 indexed' });
  });

  it('caps history at the buffer limit, newest first', () => {
    for (let i = 0; i < activity.ACTIVITY_HISTORY_LIMIT + 5; i += 1) {
      const h = activity.begin('memory.distill', 'Distilling facts');
      activity.end(h, { worked: true, detail: `run ${i}` });
    }
    const { history } = activity.snapshot();
    expect(history).toHaveLength(activity.ACTIVITY_HISTORY_LIMIT);
    expect(history[0].detail).toBe(`run ${activity.ACTIVITY_HISTORY_LIMIT + 4}`);
  });

  it('keeps a stepped job as one entry across resumptions', () => {
    const first = activity.begin('memory.rebuild', 'Rebuilding', { stepped: true });
    activity.progress(first, { done: 10, total: 100 });
    activity.yieldStep(first);
    const second = activity.begin('memory.rebuild', 'Rebuilding', { stepped: true });

    expect(second.id).toBe(first.id);
    expect(activity.snapshot().running).toHaveLength(1);
    expect(activity.snapshot().running[0].progress).toEqual({ done: 10, total: 100 });
  });

  it('accumulates working time but not the gap between steps', () => {
    const handle = activity.begin('folders.learn', 'Learning', { stepped: true });
    vi.advanceTimersByTime(2_000);
    activity.yieldStep(handle);
    // Yielded to interactive work for a long while — must not count as working.
    vi.advanceTimersByTime(600_000);
    expect(activity.snapshot().running[0].activeMs).toBe(2_000);

    activity.begin('folders.learn', 'Learning', { stepped: true });
    vi.advanceTimersByTime(3_000);
    activity.end(handle, { worked: true });
    expect(activity.snapshot().history[0].activeMs).toBe(5_000);
  });

  it('counts the in-flight step in a running entry so the panel is not frozen', () => {
    const handle = activity.begin('memory.distill', 'Distilling facts');
    vi.advanceTimersByTime(1_500);
    expect(activity.snapshot().running[0].activeMs).toBe(1_500);
    activity.end(handle, { worked: true });
  });

  it('records a failure with no handle — the swallowed-catch case', () => {
    // distill.ts catches internally and returns 0, so the only place that knows
    // the run failed is inside the function, with no handle in scope.
    activity.fail('memory.distill', new Error('model offline'), 'Distilling facts');
    const snap = activity.snapshot();
    expect(snap.unseenFailure).toBe(true);
    expect(snap.history[0]).toMatchObject({
      state: 'failed',
      error: 'model offline',
      label: 'Distilling facts'
    });
  });

  it('fails the open run for a kind rather than adding a second row', () => {
    const handle = activity.begin('folders.embed', 'Embedding Notes');
    vi.advanceTimersByTime(1_000);
    activity.fail('folders.embed', new Error('worker died'));
    expect(activity.snapshot().running).toHaveLength(0);
    expect(activity.snapshot().history).toHaveLength(1);
    expect(activity.snapshot().history[0].activeMs).toBe(1_000);

    // The caller's own end() lands after the internal failure and must be inert.
    activity.end(handle, { worked: true, detail: 'should not appear' });
    expect(activity.snapshot().history).toHaveLength(1);
    expect(activity.snapshot().history[0].state).toBe('failed');
  });

  it('clears the sticky failure marker only when the panel is opened', () => {
    activity.fail('skills.curate', 'nope');
    expect(activity.snapshot().unseenFailure).toBe(true);
    const later = activity.begin('memory.distill', 'Distilling facts');
    activity.end(later, { worked: true });
    expect(activity.snapshot().unseenFailure).toBe(true);
    activity.markSeen();
    expect(activity.snapshot().unseenFailure).toBe(false);
  });

  it('closes an event-driven job by kind, and no-ops when nothing is open', () => {
    // A cached model reports straight to 'ready' with no download in flight.
    activity.endByKind('models.embed', { worked: true, detail: 'Ready' });
    expect(activity.snapshot().history).toHaveLength(0);

    activity.begin('models.embed', 'Preparing embedding model', { stepped: true });
    activity.endByKind('models.embed', { worked: true, detail: 'Ready · 384-dim' });
    expect(activity.snapshot().history[0].detail).toBe('Ready · 384-dim');
  });

  it('coalesces a burst of changes into one emit', () => {
    const seen: ActivitySnapshot[] = [];
    activity.setActivityEmitter((s) => seen.push(s));
    for (const kind of ['memory.distill', 'memory.summaries', 'memory.adjudicate'] as const) {
      const h = activity.begin(kind, kind);
      activity.end(h, { worked: true });
    }
    expect(seen).toHaveLength(0); // debounced, nothing yet
    vi.advanceTimersByTime(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].history).toHaveLength(3);
  });

  it('reports a failure through track() and rethrows for the caller', async () => {
    await expect(
      activity.track('memory.consolidate', 'Tidying memory', async () => {
        throw new Error('boom');
      }, () => ({ worked: true }))
    ).rejects.toThrow('boom');
    expect(activity.snapshot().history[0]).toMatchObject({ state: 'failed', error: 'boom' });
  });
});
