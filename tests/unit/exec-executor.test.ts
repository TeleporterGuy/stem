import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  clampTimeout,
  DEFAULT_TIMEOUT_MS,
  execEnv,
  MAX_TIMEOUT_MS,
  OUTPUT_CAP_BYTES,
  runCommand
} from '../../src/main/exec/executor';

// The run_command spawn layer: real /bin/zsh children with output caps,
// timeouts, and process-group kills. Spawn tests are gated on zsh being present
// (macOS always; Linux CI may lack it).

const hasZsh = existsSync('/bin/zsh');

describe('clampTimeout', () => {
  it('defaults, clamps, and floors', () => {
    expect(clampTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(10)).toBe(1000);
    expect(clampTimeout(5000)).toBe(5000);
    expect(clampTimeout(10 * MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
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
      expect(env.HOME).toBe(process.env.HOME);
    } finally {
      delete process.env.STEM_TEST_SECRET;
      delete process.env.PI_TEST_DIR;
    }
  });
});

describe.skipIf(!hasZsh)('runCommand', () => {
  const base = { cwd: tmpdir(), timeoutMs: 10_000, env: execEnv(process.env.PATH ?? '') };

  it('captures stdout, stderr, and the exit code', async () => {
    const outcome = await runCommand({ ...base, command: 'printf hello; printf oops >&2; exit 3' });
    expect(outcome.stdout).toBe('hello');
    expect(outcome.stderr).toBe('oops');
    expect(outcome.exitCode).toBe(3);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.truncated).toBe(false);
  });

  it('kills a hung command at the timeout', async () => {
    const outcome = await runCommand({ ...base, command: 'sleep 30', timeoutMs: 1000 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
  }, 15_000);

  it('caps runaway output with a truncation marker', async () => {
    const outcome = await runCommand({ ...base, command: 'head -c 200000 /dev/zero | tr "\\0" "x"' });
    expect(outcome.truncated).toBe(true);
    expect(outcome.stdout).toContain(`truncated at ${OUTPUT_CAP_BYTES} bytes`);
    expect(outcome.stdout.length).toBeLessThan(OUTPUT_CAP_BYTES + 200);
  });

  it('an abort kills the process group', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const outcome = await runCommand({ ...base, command: 'sleep 30', signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.exitCode).not.toBe(0);
  }, 15_000);
});
