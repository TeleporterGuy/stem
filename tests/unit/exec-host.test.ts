import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExecHost, type ExecHost } from '../../src/desktop/exec-host';
import { writeExecHostEnabled } from '../../src/desktop/exec-host/store';

// The client half: the machine that actually runs a device-targeted command.
// What must hold here is the consent gate — the opt-in switch on THIS disk is
// read fresh per request, so a server that sends a frame to a machine that
// never opted in (or opted out again) spawns nothing and gets told so.

const winlt = process.platform === 'win32';

describe('createExecHost', () => {
  let dir: string;
  let calls: Array<{ channel: string; args: unknown[] }>;
  let host: ExecHost;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stem-exec-host-'));
    process.env.STEM_EXEC_HOST_FILE = join(dir, 'exec-host.json');
    calls = [];
    host = createExecHost({
      invoke: (channel, args) => {
        calls.push({ channel, args });
        return Promise.resolve(undefined);
      }
    });
  });

  afterEach(() => {
    delete process.env.STEM_EXEC_HOST_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  async function lastResult(): Promise<{ ok: boolean; text?: string; error?: string }> {
    for (let i = 0; i < 400; i++) {
      const call = calls.find((c) => c.channel === 'execHost:result');
      if (call) return call.args[1] as { ok: boolean; text?: string; error?: string };
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no execHost:result was delivered');
  }

  it('starts switched off, and refuses a request without spawning anything', async () => {
    expect((await host.localState()).enabled).toBe(false);
    host.onRequest({ requestId: 'r1', threadId: 't1', command: 'echo leaked', timeoutMs: 5_000 });
    const result = await lastResult();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not accept commands');
    // The refusal names the requestId it answers for.
    expect(calls.find((c) => c.channel === 'execHost:result')!.args[0]).toBe('r1');
  });

  it('announces its platform and switch state, and re-announces on toggle', async () => {
    await host.start();
    const first = calls.find((c) => c.channel === 'execHost:announce')!.args[0] as {
      enabled: boolean;
      platform: string;
    };
    expect(first.enabled).toBe(false);
    expect(['darwin', 'linux', 'win32']).toContain(first.platform);
    await host.setEnabled(true);
    const announcements = calls.filter((c) => c.channel === 'execHost:announce');
    expect(announcements).toHaveLength(2);
    expect((announcements[1]!.args[0] as { enabled: boolean }).enabled).toBe(true);
  });

  it.skipIf(winlt)('runs a command once enabled, in this chat’s scratch folder by default', async () => {
    await writeExecHostEnabled(true);
    host.onRequest({ requestId: 'r2', threadId: 'thread-a', command: 'pwd && echo done', timeoutMs: 30_000 });
    const result = await lastResult();
    expect(result.ok).toBe(true);
    // The same block format the local executor produces.
    expect(result.text).toContain('Exit code: 0');
    expect(result.text).toContain(join('exec-scratch', 'thread-a'));
    expect(result.text).toContain('done');
  });

  it('refuses a cwd that does not exist on this machine', async () => {
    await writeExecHostEnabled(true);
    host.onRequest({
      requestId: 'r3',
      threadId: 't1',
      command: 'echo hi',
      cwd: join(dir, 'no-such-dir'),
      timeoutMs: 5_000
    });
    const result = await lastResult();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not exist on this computer');
  });
});
