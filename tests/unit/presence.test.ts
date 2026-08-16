// Is somebody at a desk? The two halves of that answer, tested apart, because
// they are deliberately independent of each other:
//
//   the CLIENT decides. src/desktop/presence.ts reads the OS idle timer and
//   reports only while it is small — and once it isn't, the reports stop. That
//   silence is the whole signal, so the gate that produces it is tested as a
//   pure function, and the loop around it is tested for the things a background
//   timer gets wrong: retry storms, overlapping calls, and beats after close.
//
//   the SERVER believes. `devices:presence` records the CALLING device and does
//   not read the number it was handed. The test for that asserts the absence:
//   a machine claiming four idle hours still counts as present, because it only
//   counts as present by virtue of having said anything at all.
//
// Nothing here touches Electron or a socket. powerMonitor and the proxy are the
// two injected dependencies of the heartbeat for exactly this reason, and the
// channel is driven through dispatchLocal the way the transport drives it.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchLocal } from '../../src/server/ipc/guard';
import { registerDevicesIpc } from '../../src/server/ipc/devices';
import { forgetPresence, isAnyDesktopPresent, lastActiveAt } from '../../src/server/push/presence';
import {
  createPresenceHeartbeat,
  shouldReportPresence,
  HEARTBEAT_EVERY_MS,
  PRESENCE_IDLE_LIMIT_SECONDS
} from '../../src/desktop/presence';

describe('the devices:presence channel', () => {
  beforeAll(() => {
    registerDevicesIpc();
  });

  beforeEach(() => {
    forgetPresence();
  });

  it('marks the CALLING device as occupied, and no other', async () => {
    await dispatchLocal('devices:presence', [12], { deviceId: 'laptop' });

    expect(lastActiveAt('laptop')).toBeGreaterThan(0);
    expect(lastActiveAt('desktop')).toBeNull();
    expect(isAnyDesktopPresent()).toBe(true);
  });

  it('does not interpret the idle seconds it is sent', async () => {
    // The number is informational and the server says so: a report ARRIVING is
    // the claim. If this ever starts failing because the handler grew an opinion
    // about the value, the two ends now have two definitions of "present" and
    // they will drift.
    await dispatchLocal('devices:presence', [4 * 60 * 60], { deviceId: 'laptop' });

    expect(isAnyDesktopPresent()).toBe(true);
  });

  it('learns nothing from a call with no device behind it', async () => {
    // dispatchLocal without a caller is an in-process call — a desktop window
    // over ipcMain. There is no machine such a call could be about, so it is
    // ignored rather than refused: nothing is broken, there is just nothing to
    // record.
    await expect(dispatchLocal('devices:presence', [3])).resolves.toBeUndefined();

    expect(isAnyDesktopPresent()).toBe(false);
  });

  it('refuses a report that is not a number of seconds', async () => {
    for (const bad of [['soon'], [null], [], [{}]]) {
      await expect(dispatchLocal('devices:presence', bad, { deviceId: 'laptop' })).rejects.toThrow();
    }
    expect(isAnyDesktopPresent()).toBe(false);
  });

  it('stops counting once the window has passed', async () => {
    await dispatchLocal('devices:presence', [1], { deviceId: 'laptop' });

    // Asked about a window shorter than the report is old — the same arithmetic
    // the real five-minute window does, without waiting five minutes.
    await new Promise((r) => setTimeout(r, 5));
    expect(isAnyDesktopPresent(1)).toBe(false);
    expect(isAnyDesktopPresent()).toBe(true);
  });
});

describe('deciding whether to report', () => {
  it('reports while the machine is in use, and falls silent once it is not', () => {
    expect(shouldReportPresence(0, true)).toBe(true);
    expect(shouldReportPresence(59, true)).toBe(true);
    expect(shouldReportPresence(PRESENCE_IDLE_LIMIT_SECONDS - 1, true)).toBe(true);
    // At the limit is already too idle: the boundary belongs to silence, so the
    // suppression window can only ever err towards sending a push.
    expect(shouldReportPresence(PRESENCE_IDLE_LIMIT_SECONDS, true)).toBe(false);
    expect(shouldReportPresence(6 * 60, true)).toBe(false);
  });

  it('treats an idle timer that cannot answer as no evidence at all', () => {
    // powerMonitor is a native call. A platform that returns nonsense must not
    // be able to silence somebody's phone by accident — the failure mode of
    // this whole feature is a redundant notification, never a missed one.
    for (const bad of [NaN, Infinity, -1, -0.5]) {
      expect(shouldReportPresence(bad, true)).toBe(false);
    }
  });

  it('does not take a zero on trust from a timer never seen to move', () => {
    // Zero is the answer a working timer gives while somebody types AND the
    // answer a dead one (XWayland's missing idle extension) gives forever. Until
    // the timer has been observed at some other value there is nothing to tell
    // them apart, and believing it is the failure that has no symptom.
    expect(shouldReportPresence(0, false)).toBe(false);
    // Any nonzero reading is its own proof, so nothing is withheld from a
    // machine whose timer works.
    expect(shouldReportPresence(1, false)).toBe(true);
    expect(shouldReportPresence(PRESENCE_IDLE_LIMIT_SECONDS - 1, false)).toBe(true);
  });
});

describe('the heartbeat', () => {
  let idle = 0;
  let reported: number[] = [];
  /** Swapped per test to make a report fail or hang. */
  let answer: () => Promise<unknown> = async () => undefined;

  function heartbeat() {
    return createPresenceHeartbeat({
      idleSeconds: () => idle,
      report: (seconds) => {
        reported.push(seconds);
        return answer();
      }
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // A machine last touched a few seconds ago: in use, and its idle timer
    // visibly counting — which is what most of these tests are not about. The
    // constant-zero backend has its own tests below.
    idle = 5;
    reported = [];
    answer = async () => undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports at once and then keeps reporting', async () => {
    const beat = heartbeat();
    beat.start();
    // Launching Stem is itself input; waiting out the first interval would leave
    // a minute in which the phone of somebody at their desk could be woken.
    expect(reported).toEqual([5]);

    idle = 30;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
    expect(reported).toEqual([5, 30]);

    beat.close();
  });

  it('says nothing at all to an idle timer stuck at zero', async () => {
    // XWayland, and anywhere else the X idle extension is absent: getSystemIdleTime
    // returns a constant zero and never throws. Every beat then LOOKS like somebody
    // with a hand on the mouse, and believing it would suppress every push to this
    // user's phone for the life of the process — the one failure this feature must
    // not have, because it produces no symptom to notice.
    idle = 0;
    const beat = heartbeat();
    beat.start();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS * 10);
    expect(reported).toEqual([]);

    beat.close();
  });

  it('trusts a zero once it has seen the timer count', async () => {
    // The other side of the same rule: somebody typing continuously reads zero
    // beat after beat on a perfectly good timer, and they are at their desk. One
    // nonzero reading is all it takes to tell that machine from the broken one.
    idle = 12;
    const beat = heartbeat();
    beat.start();
    expect(reported).toEqual([12]);

    idle = 0;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS * 2);
    expect(reported).toEqual([12, 0, 0]);

    beat.close();
  });

  it('goes quiet once the machine is idle, and speaks again when it is used', async () => {
    const beat = heartbeat();
    beat.start();
    reported = [];

    idle = PRESENCE_IDLE_LIMIT_SECONDS + 1;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS * 3);
    // Nothing was sent, which is the entire suppression contract: the server
    // hears silence and lets the push through.
    expect(reported).toEqual([]);

    idle = 2;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
    expect(reported).toEqual([2]);

    beat.close();
  });

  it('drops a failed report instead of retrying it', async () => {
    answer = () => Promise.reject(new Error("Stem's server is unreachable"));
    const beat = heartbeat();
    beat.start();
    expect(reported).toHaveLength(1);

    // No backoff, no queue, no second attempt before the next scheduled tick —
    // the beat that failed described a minute that has already passed.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS - 1);
    expect(reported).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reported).toHaveLength(2);

    beat.close();
  });

  it('never stacks reports behind one that has not answered', async () => {
    answer = () => new Promise(() => {});
    const beat = heartbeat();
    beat.start();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS * 5);
    // A hung POST (the proxy's own timeout is longer than a tick) must not turn
    // into five in flight at once.
    expect(reported).toHaveLength(1);

    beat.close();
  });

  it('says nothing after close, and cannot be restarted into two timers', async () => {
    const beat = heartbeat();
    beat.start();
    beat.close();
    reported = [];

    beat.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS * 3);
    expect(reported).toEqual([]);
  });

  it('survives an idle timer that throws', async () => {
    const beat = createPresenceHeartbeat({
      idleSeconds: () => {
        throw new Error('no power monitor here');
      },
      report: async () => reported.push(-1)
    });

    expect(() => beat.start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS * 2);
    expect(reported).toEqual([]);

    beat.close();
  });
});
