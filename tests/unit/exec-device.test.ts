import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createExecDeviceRouter,
  memoryExecHostStore,
  resolveExecTarget,
  type ExecDeviceRouter
} from '../../src/server/exec-device/router';
import { forgetCachedDevices, mintDevice } from '../../src/server/transport/auth';
import { EXEC_REQUEST_FRAME, type DeviceExecRequest } from '../../src/shared/types';

// The server half of run_command's `device` target: the addressed frame out,
// the RPC answer back, and everything that must hold in between — the same
// invariants mcp-device.test.ts pins for tool calls, for commands.

interface Sent {
  deviceId: string;
  name: string;
  data: DeviceExecRequest;
}

describe('createExecDeviceRouter', () => {
  let sent: Sent[];
  let connected: Set<string>;
  let router: ExecDeviceRouter;

  beforeEach(() => {
    sent = [];
    connected = new Set(['mac-1']);
    router = createExecDeviceRouter({
      pushTo: (deviceId, name, data) => {
        if (!connected.has(deviceId)) return 0;
        sent.push({ deviceId, name, data: data as DeviceExecRequest });
        return 1;
      },
      connectedDevices: () => connected,
      store: memoryExecHostStore()
    });
  });

  afterEach(() => router.close());

  it('remembers a valid announcement and ignores a malformed one', async () => {
    await router.announce('mac-1', { enabled: true, platform: 'darwin' });
    await router.announce('mac-1', { enabled: 'yes', platform: 'darwin' }); // ignored
    await router.announce('mac-1', { enabled: true, platform: 'beos' }); // ignored
    const host = await router.hostFor('mac-1');
    expect(host).toMatchObject({ enabled: true, platform: 'darwin' });
  });

  it('round-trips one command: frame out, settle back, single-use id', async () => {
    const promise = router.run('mac-1', { threadId: 't1', command: 'echo hi', timeoutMs: 5_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe(EXEC_REQUEST_FRAME);
    const frame = sent[0]!.data;
    expect(frame.command).toBe('echo hi');
    expect(frame.threadId).toBe('t1');
    // 128 bits of hex, not a counter: it is the whole defence against a caller
    // that can reach execHost:result but was never handed this request.
    expect(frame.requestId).toMatch(/^[0-9a-f]{32}$/);

    expect(router.settle('mac-1', frame.requestId, { ok: true, text: 'Exit code: 0' })).toBe(true);
    await expect(promise).resolves.toEqual({ ok: true, text: 'Exit code: 0' });
    // Spent on first use.
    expect(router.settle('mac-1', frame.requestId, { ok: true, text: 'again' })).toBe(false);
  });

  it('refuses an answer from a device the request was not sent to', async () => {
    const promise = router.run('mac-1', { threadId: 't1', command: 'echo hi', timeoutMs: 5_000 });
    const { requestId } = sent[0]!.data;
    expect(router.settle('other-device', requestId, { ok: true, text: 'forged' })).toBe(false);
    // The rightful device can still answer.
    expect(router.settle('mac-1', requestId, { ok: false, error: 'nope' })).toBe(true);
    await expect(promise).resolves.toEqual({ ok: false, error: 'nope' });
  });

  it('normalizes an unusable answer into a failure instead of an ok with nothing in it', async () => {
    const promise = router.run('mac-1', { threadId: 't1', command: 'x', timeoutMs: 5_000 });
    router.settle('mac-1', sent[0]!.data.requestId, { ok: true });
    const result = await promise;
    expect(result.ok).toBe(false);
  });

  it('answers immediately when the write reaches no stream', async () => {
    connected = new Set(); // pushTo returns 0
    const result = await router.run('mac-1', { threadId: 't1', command: 'echo hi', timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('disconnected');
  });

  it('cancels a thread’s in-flight commands without touching another thread’s', async () => {
    const a = router.run('mac-1', { threadId: 'stop-me', command: 'sleep 99', timeoutMs: 5_000 });
    const b = router.run('mac-1', { threadId: 'keep-me', command: 'sleep 99', timeoutMs: 5_000 });
    router.abortThread('stop-me');
    await expect(a).resolves.toEqual({ ok: false, error: 'The command was cancelled.' });
    router.settle('mac-1', sent[1]!.data.requestId, { ok: true, text: 'done' });
    await expect(b).resolves.toEqual({ ok: true, text: 'done' });
  });

  it('forget() fails in-flight commands and drops the announcement', async () => {
    await router.announce('mac-1', { enabled: true, platform: 'darwin' });
    const promise = router.run('mac-1', { threadId: 't1', command: 'x', timeoutMs: 5_000 });
    await router.forget('mac-1');
    const result = await promise;
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('unpaired');
    expect(await router.hostFor('mac-1')).toBeNull();
  });
});

describe('resolveExecTarget', () => {
  beforeEach(() => {
    rmSync(process.env.STEM_DEVICES_FILE!, { force: true });
    forgetCachedDevices();
  });

  afterEach(() => {
    rmSync(process.env.STEM_DEVICES_FILE!, { force: true });
    forgetCachedDevices();
  });

  it('matches a device label case-insensitively and by id', async () => {
    const minted = await mintDevice("Vlado's MacBook", 'desktop');
    const byLabel = await resolveExecTarget("vlado's macbook");
    expect(byLabel).toMatchObject({ ok: true, deviceId: minted.device.id, label: "Vlado's MacBook" });
    const byId = await resolveExecTarget(minted.device.id);
    expect(byId).toMatchObject({ ok: true, deviceId: minted.device.id });
  });

  it('names the paired computers when nothing matches', async () => {
    await mintDevice('Office iMac', 'desktop');
    const result = await resolveExecTarget('Basement PC');
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('“Office iMac”');
  });

  it('refuses a phone — commands only run on computers', async () => {
    await mintDevice('My phone', 'mobile');
    const result = await resolveExecTarget('My phone');
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('phone');
  });

  it('refuses an ambiguous label rather than guessing', async () => {
    await mintDevice('MacBook', 'desktop');
    await mintDevice('MacBook', 'desktop');
    const result = await resolveExecTarget('MacBook');
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('More than one');
  });
});
