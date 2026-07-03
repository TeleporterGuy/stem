// resolvePi suite — the pi invocation resolver. The STEM_PI_PATH override and
// the bundled-package path are deterministic in this repo (the package is a
// real dependency); the system-scan fallback is environment-dependent and left
// to manual verification.
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePi, resetPiCacheForTests } from '../../src/main/pi/locate';

const savedOverride = process.env.STEM_PI_PATH;

afterEach(() => {
  if (savedOverride === undefined) delete process.env.STEM_PI_PATH;
  else process.env.STEM_PI_PATH = savedOverride;
  resetPiCacheForTests();
});

describe('resolvePi', () => {
  it('honors the STEM_PI_PATH override verbatim', async () => {
    process.env.STEM_PI_PATH = '/opt/custom/pi';
    resetPiCacheForTests();
    const pi = await resolvePi();
    expect(pi).toMatchObject({
      command: '/opt/custom/pi',
      prefixArgs: [],
      source: 'override',
      displayPath: '/opt/custom/pi'
    });
  });

  it('memoizes until the test cache reset', async () => {
    process.env.STEM_PI_PATH = '/opt/custom/pi';
    resetPiCacheForTests();
    expect((await resolvePi())?.source).toBe('override');
    // Changing the env without a reset returns the cached value…
    delete process.env.STEM_PI_PATH;
    expect((await resolvePi())?.source).toBe('override');
    // …and the reset makes the next resolution see the new env.
    resetPiCacheForTests();
    expect((await resolvePi())?.source).not.toBe('override');
  });

  it('prefers the bundled package when no override is set', async () => {
    delete process.env.STEM_PI_PATH;
    resetPiCacheForTests();
    const pi = await resolvePi();
    // The package is a real dependency of this repo, so the bundled path must
    // resolve (under vitest import.meta.resolve sees node_modules).
    expect(pi?.source).toBe('bundled');
    expect(pi?.command).toBe(process.execPath);
    expect(pi?.prefixArgs[0]).toMatch(/pi-coding-agent[/\\]dist[/\\]cli\.js$/);
    expect(pi?.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
