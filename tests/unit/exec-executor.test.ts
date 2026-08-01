import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  clampTimeout,
  DEFAULT_TIMEOUT_MS,
  execEnv,
  hostShellLabel,
  MAX_TIMEOUT_MS,
  OUTPUT_CAP_BYTES,
  runCommand,
  shellInvocation
} from '../../src/main/exec/executor';

// The run_command spawn layer: real shell children with output caps, timeouts,
// and process-tree kills. Spawn tests are gated on the host shell being present
// (zsh on Unix; cmd.exe on Windows).

const hasZsh = existsSync('/bin/zsh');
const isWin = process.platform === 'win32';
const canSpawn = isWin || hasZsh;

describe('clampTimeout', () => {
  it('defaults, clamps, and floors', () => {
    expect(clampTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(10)).toBe(1000);
    expect(clampTimeout(5000)).toBe(5000);
    expect(clampTimeout(10 * MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
  });
});

describe('shellInvocation', () => {
  it('uses zsh -c on Unix platforms', () => {
    expect(shellInvocation('echo hi', 'darwin')).toEqual({
      command: '/bin/zsh',
      args: ['-c', 'echo hi'],
      detached: true
    });
    expect(shellInvocation('echo hi', 'linux')).toEqual({
      command: '/bin/zsh',
      args: ['-c', 'echo hi'],
      detached: true
    });
  });

  it('uses cmd.exe /d /s /c on win32 (no AutoRun)', () => {
    const inv = shellInvocation('echo hi', 'win32');
    expect(inv.args).toEqual(['/d', '/s', '/c', 'echo hi']);
    expect(inv.detached).toBe(false);
    // ComSpec may be set; otherwise the default is cmd.exe.
    expect(inv.command.toLowerCase()).toMatch(/cmd\.exe$/);
  });

  it('labels the host shell for tool/judge copy', () => {
    expect(hostShellLabel('win32')).toContain('cmd.exe');
    expect(hostShellLabel('darwin')).toContain('zsh');
  });
});

describe('execEnv', () => {
  it('strips Stem/pi internals and applies the login PATH', () => {
    process.env.STEM_TEST_SECRET = 'x';
    process.env.PI_TEST_DIR = 'y';
    try {
      const env = execEnv('/opt/homebrew/bin:/usr/bin');
      expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
      expect(env.STEM_TEST_SECRET).toBeUndefined();
      expect(env.PI_TEST_DIR).toBeUndefined();
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      if (process.platform !== 'win32') {
        expect(env.HOME).toBe(process.env.HOME);
      }
    } finally {
      delete process.env.STEM_TEST_SECRET;
      delete process.env.PI_TEST_DIR;
    }
  });
});

describe.skipIf(!canSpawn)('runCommand', () => {
  const pathEnv = process.env.Path || process.env.PATH || '';
  const base = { cwd: tmpdir(), timeoutMs: 10_000, env: execEnv(pathEnv) };

  it('captures stdout, stderr, and the exit code', async () => {
    const command = isWin
      ? 'echo hello& echo oops 1>&2& exit /b 3'
      : 'printf hello; printf oops >&2; exit 3';
    const outcome = await runCommand({ ...base, command });
    expect(outcome.stdout.trim()).toBe('hello');
    expect(outcome.stderr).toContain('oops');
    expect(outcome.exitCode).toBe(3);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.truncated).toBe(false);
  });

  it('kills a hung command at the timeout', async () => {
    const command = isWin ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 30';
    const outcome = await runCommand({ ...base, command, timeoutMs: 1000 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
  }, 15_000);

  it('caps runaway output with a truncation marker', async () => {
    const command = isWin
      ? // ~200KB of repeated 'x' via a short PowerShell one-liner — NoProfile so
        // a blocked profile.ps1 cannot abort the spawn used only for this test.
        'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Write-Output (\'x\' * 200000)"'
      : 'head -c 200000 /dev/zero | tr "\\0" "x"';
    const outcome = await runCommand({ ...base, command, timeoutMs: 30_000 });
    expect(outcome.truncated).toBe(true);
    expect(outcome.stdout).toContain(`truncated at ${OUTPUT_CAP_BYTES} bytes`);
    expect(outcome.stdout.length).toBeLessThan(OUTPUT_CAP_BYTES + 200);
  }, 45_000);

  it('an abort kills the process tree', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const command = isWin ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 30';
    const outcome = await runCommand({ ...base, command, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.exitCode).not.toBe(0);
  }, 15_000);
});
