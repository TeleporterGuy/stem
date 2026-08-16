// resolvePi suite — the pi invocation resolver. The STEM_PI_PATH override and
// the bundled-package path are deterministic in this repo (the package is a
// real dependency); the system-scan fallback is environment-dependent and left
// to manual verification.
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePi, resetPiCacheForTests } from '../../src/server/pi/locate';
import { resetHostForTests, setHost } from '../../src/server/host';

const savedOverride = process.env.STEM_PI_PATH;

afterEach(() => {
  if (savedOverride === undefined) delete process.env.STEM_PI_PATH;
  else process.env.STEM_PI_PATH = savedOverride;
  resetPiCacheForTests();
  resetHostForTests();
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
    // The Dock-icon shim runs first, then pi's real cli.js.
    expect(pi?.prefixArgs[0]).toMatch(/pi-node-shim\.mjs$/);
    expect(pi?.prefixArgs[1]).toMatch(/pi-coding-agent[/\\]dist[/\\]cli\.js$/);
    // How the child is launched comes from the host shim: plain node headless.
    expect(pi?.command).toBe(process.execPath);
    expect(pi?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  // Under Electron the same resolution has to come back with Electron's own
  // binary plus the per-child ELECTRON_RUN_AS_NODE — that pairing is the whole
  // reason nodeSpawn() is one method and not two.
  it('takes the launch shape from the host, so Electron gets run-as-node', async () => {
    delete process.env.STEM_PI_PATH;
    setHost({ nodeSpawn: () => ({ command: '/Applications/Stem.app/Electron', env: { ELECTRON_RUN_AS_NODE: '1' } }) });
    resetPiCacheForTests();
    const pi = await resolvePi();
    expect(pi?.command).toBe('/Applications/Stem.app/Electron');
    expect(pi?.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
