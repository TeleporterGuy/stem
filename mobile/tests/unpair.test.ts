// Unpairing: what the server is told, and what happens when it cannot be.
//
// The order is the load-bearing part. `devices:revoke` is authenticated by the
// token it revokes, so a local clear that happened first would leave the row —
// and the APNs token in it — on the server for good, with the phone still being
// woken for chats it can no longer open.

import { describe, expect, it, vi } from 'vitest';
import { unpairDevice } from '../src/transport/unpair';

describe('unpairDevice', () => {
  it('asks the server to forget this phone, by its own id, before dropping the credential', async () => {
    const order: string[] = [];
    const revoke = vi.fn(async (id: string) => {
      order.push(`revoke:${id}`);
    });

    await unpairDevice({
      deviceId: 'device-7',
      revoke,
      forget: async () => {
        order.push('forget');
      }
    });

    expect(revoke).toHaveBeenCalledWith('device-7');
    expect(order).toEqual(['revoke:device-7', 'forget']);
  });

  it('forgets locally anyway when the server refuses or is not there', async () => {
    const logged: string[] = [];
    let forgotten = false;

    await unpairDevice({
      deviceId: 'device-7',
      revoke: () => Promise.reject(new Error('could not reach https://stem.example')),
      forget: async () => {
        forgotten = true;
      },
      log: (message) => logged.push(message)
    });
    // The rejection is handled inside, so it neither throws here nor surfaces
    // later as an unhandled one.
    await Promise.resolve();

    expect(forgotten).toBe(true);
    expect(logged).toEqual(['the server was not told to forget this phone']);
  });

  it('does not wait for the revoke to come back', async () => {
    // The commonest reason to unpair is a server that is gone. Waiting out a
    // request to a machine that will never answer, in order to stop talking to
    // it, would be the wrong way round.
    let forgotten = false;

    await unpairDevice({
      deviceId: 'device-7',
      revoke: () => new Promise(() => undefined),
      forget: async () => {
        forgotten = true;
      }
    });

    expect(forgotten).toBe(true);
  });

  it('has nothing to revoke when there is no stored pairing', async () => {
    const revoke = vi.fn(async () => undefined);
    let forgotten = false;

    await unpairDevice({
      deviceId: null,
      revoke,
      forget: async () => {
        forgotten = true;
      }
    });

    expect(revoke).not.toHaveBeenCalled();
    expect(forgotten).toBe(true);
  });
});
