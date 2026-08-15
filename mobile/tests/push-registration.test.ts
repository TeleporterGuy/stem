// Getting woken, and the four ways it can decline to happen.
//
// The gate is what matters here: iOS grants exactly one permission prompt per
// install, so spending it before there is a server to notify about would be
// spending it on nothing — and Expo Go, where half of this development happens,
// has no APNs token to give at all and must not turn that into a crash.

import { describe, expect, it, vi } from 'vitest';
import { registerForPush, type PermissionState, type PushPlatform } from '../src/notifications/register';

function platform(overrides: Partial<PushPlatform> & { permission?: PermissionState } = {}): PushPlatform {
  const permission = overrides.permission ?? 'granted';
  return {
    getPermission: overrides.getPermission ?? (async () => permission),
    requestPermission: overrides.requestPermission ?? (async () => permission),
    getDeviceToken: overrides.getDeviceToken ?? (async () => 'a'.repeat(64))
  };
}

describe('registerForPush', () => {
  it('registers the native token once every condition is met', async () => {
    const register = vi.fn(async () => undefined);
    const outcome = await registerForPush({ paired: true, platform: platform(), register });

    expect(outcome).toBe('registered');
    expect(register).toHaveBeenCalledWith('a'.repeat(64));
  });

  it('does nothing before pairing — the prompt is worth more later', async () => {
    const getPermission = vi.fn(async (): Promise<PermissionState> => 'granted');
    const register = vi.fn(async () => undefined);

    expect(await registerForPush({ paired: false, platform: platform({ getPermission }), register })).toBe(
      'unpaired'
    );
    // Not even asked: an app that requests notifications before it has anything
    // to notify you about is an app people say no to, once, permanently.
    expect(getPermission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('asks only when nothing has been decided yet', async () => {
    const requestPermission = vi.fn(async (): Promise<PermissionState> => 'granted');
    await registerForPush({
      paired: true,
      platform: platform({ permission: 'granted', requestPermission }),
      register: async () => undefined
    });
    expect(requestPermission).not.toHaveBeenCalled();

    await registerForPush({
      paired: true,
      platform: platform({ getPermission: async () => 'undetermined', requestPermission }),
      register: async () => undefined
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('takes a refusal as final and never re-prompts', async () => {
    const requestPermission = vi.fn(async (): Promise<PermissionState> => 'granted');
    const register = vi.fn(async () => undefined);
    const outcome = await registerForPush({
      paired: true,
      platform: platform({ getPermission: async () => 'denied', requestPermission }),
      register
    });

    expect(outcome).toBe('denied');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('degrades silently where there is no native token — Expo Go, a simulator', async () => {
    const register = vi.fn(async () => undefined);
    const log = vi.fn();
    const thrown = await registerForPush({
      paired: true,
      platform: platform({
        getDeviceToken: async () => {
          throw new Error('getDevicePushTokenAsync is not supported in Expo Go');
        }
      }),
      register,
      log
    });

    expect(thrown).toBe('unsupported');
    expect(register).not.toHaveBeenCalled();
    // Said once, in the log, and never on screen: everything else in the app
    // works in Expo Go and a development run should not be nagged.
    expect(log).toHaveBeenCalledTimes(1);

    expect(
      await registerForPush({
        paired: true,
        platform: platform({ getDeviceToken: async () => null }),
        register
      })
    ).toBe('unsupported');
  });

  it('treats a server that could not be told as this launch only', async () => {
    const outcome = await registerForPush({
      paired: true,
      platform: platform(),
      register: async () => {
        throw new Error('could not reach https://stem.example.com');
      }
    });
    // 'failed', not 'unsupported': the next launch and the next token rotation
    // both try again, because the handler on the other side is idempotent.
    expect(outcome).toBe('failed');
  });

  it('never throws, whatever the platform does', async () => {
    await expect(
      registerForPush({
        paired: true,
        platform: platform({
          getPermission: async () => {
            throw new Error('native module missing');
          }
        }),
        register: async () => undefined
      })
    ).resolves.toBe('failed');
  });
});
