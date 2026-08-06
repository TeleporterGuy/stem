import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TESTED_PI_VERSION } from './protocol';

// Resolve how to invoke the `pi` (pi.dev coding agent) backend.
//
// Preference order:
//  1. STEM_PI_PATH env override — an explicit system binary (dev/debug escape hatch).
//  2. The bundled npm package, run with Electron's own Node (ELECTRON_RUN_AS_NODE),
//     so a fresh install needs no system pi at all.
//  3. Legacy PATH/common-location scan for a system install.

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

export interface PiInvocation {
  /** argv[0] for spawn. */
  command: string;
  /** Args that go BEFORE `--mode rpc …` (bundled: [cli.js path]). */
  prefixArgs: string[];
  /** Extra env the child needs (bundled: ELECTRON_RUN_AS_NODE). */
  env: Record<string, string>;
  source: 'override' | 'bundled' | 'system';
  /** Human-readable location for status display / diagnostics. */
  displayPath: string;
  /** Installed package version (bundled only; null when unknowable cheaply). */
  version: string | null;
}

let cached: PiInvocation | null | undefined;

export async function resolvePi(): Promise<PiInvocation | null> {
  if (cached !== undefined) return cached;

  const override = process.env.STEM_PI_PATH;
  if (override) {
    return (cached = warnIfUntested({
      command: override,
      prefixArgs: [],
      env: {},
      source: 'override',
      displayPath: override,
      version: null
    }));
  }

  const bundled = await locateBundledCli();
  if (bundled) {
    // The shim freezes process.title before pi loads: pi's title assignment
    // would otherwise check this headless Electron-as-Node child into
    // LaunchServices as a bouncing "Electron" Dock icon (see pi-node-shim.mjs).
    const shim = await locateNodeShim();
    return (cached = warnIfUntested({
      command: process.execPath,
      prefixArgs: [...(shim ? [shim] : []), bundled],
      // Per-child only — never set globally (it would break Electron child windows).
      env: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'bundled',
      displayPath: bundled,
      version: await readBundledVersion(bundled)
    }));
  }

  const system = await findSystemPi();
  return (cached = system
    ? warnIfUntested({ command: system, prefixArgs: [], env: {}, source: 'system', displayPath: system, version: null })
    : null);
}

/**
 * Version tripwire, once per process (resolution is memoized). The child runs
 * with PI_SKIP_VERSION_CHECK=1 and Stem's file-and-sentinel side-protocol has
 * broken on pi minor bumps before, so a pi other than the tested one must at
 * least announce itself in the log instead of failing silently mid-turn.
 */
function warnIfUntested(pi: PiInvocation): PiInvocation {
  if (pi.version === TESTED_PI_VERSION) return pi;
  if (pi.version) {
    console.warn(
      `[stem] pi ${pi.version} at ${pi.displayPath} differs from the tested ${TESTED_PI_VERSION} — ` +
        'the Stem bridge extension may misbehave (see src/server/pi/protocol.ts).'
    );
  } else if (pi.source !== 'bundled') {
    console.warn(
      `[stem] using a ${pi.source} pi at ${pi.displayPath} (version unknown; tested: ${TESTED_PI_VERSION}).`
    );
  }
  return pi;
}

/** Read the bundled package's version from its package.json (…/dist/cli.js → …/package.json). */
async function readBundledVersion(cliPath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cliPath, '..', '..', 'package.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** Test seam: the resolution is memoized for the process lifetime. */
export function resetPiCacheForTests(): void {
  cached = undefined;
}

async function locateBundledCli(): Promise<string | null> {
  try {
    // Resolves the package's "." export (dist/index.js); cli.js is its sibling.
    // The package is rollup-external, so this runs as real Node resolution from
    // dist/main at runtime (and from src/ under vitest).
    const indexUrl = import.meta.resolve(PI_PACKAGE);
    const cli = fileURLToPath(new URL('./cli.js', indexUrl));
    await access(cli);
    return cli;
  } catch {
    // fall through to a path relative to the built main bundle (dist/main/…)
  }
  try {
    const cli = fileURLToPath(
      new URL(`../../node_modules/${PI_PACKAGE}/dist/cli.js`, import.meta.url)
    );
    await access(cli);
    return cli;
  } catch {
    return null;
  }
}

/**
 * Locate pi-node-shim.mjs next to the built main bundle (dist/main/pi/, copied
 * by the electron-vite asset plugin) or in the source tree (vitest). Missing
 * shim degrades to a direct spawn — pi still works, just with the Dock-icon wart.
 */
async function locateNodeShim(): Promise<string | null> {
  const candidates = [
    new URL('./pi/pi-node-shim.mjs', import.meta.url), // dist/main/index.js → dist/main/pi/
    new URL('./pi-node-shim.mjs', import.meta.url) // src/server/pi/locate.ts (vitest)
  ];
  for (const candidate of candidates) {
    try {
      const path = fileURLToPath(candidate);
      await access(path);
      return path;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function findSystemPi(): Promise<string | null> {
  const fromPath = await which('pi');
  if (fromPath) return fromPath;
  // Bundled pi is the normal path; these are fallbacks for a system install.
  const candidates =
    process.platform === 'win32'
      ? [join(homedir(), 'AppData', 'Local', 'pi', 'pi.exe'), join(homedir(), '.local', 'bin', 'pi.exe')]
      : [
          join(homedir(), '.local', 'bin', 'pi'),
          ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/pi', '/usr/local/bin/pi'] : ['/usr/local/bin/pi'])
        ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Locate `bin` on PATH. Unix uses `/usr/bin/which`; Windows uses `where.exe`
 * (first match). Failures resolve to null — the caller falls through to
 * hardcoded candidates or "no system pi".
 */
function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('where.exe', [bin], { windowsHide: true }, (error, stdout) => {
        if (error) resolve(null);
        else {
          // where prints one path per line; take the first hit.
          const first = stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find(Boolean);
          resolve(first ?? null);
        }
      });
      return;
    }
    execFile('/usr/bin/which', [bin], (error, stdout) => {
      if (error) resolve(null);
      else resolve(stdout.trim() || null);
    });
  });
}
