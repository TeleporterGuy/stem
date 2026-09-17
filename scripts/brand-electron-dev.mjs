// Brand the dev Electron bundle so the dock tooltip and macOS menu-bar title
// read "Stem" instead of "Electron", and so macOS 15+ can prompt for Local
// Network access. Those come from Info.plist in the running app bundle, which
// in dev is Electron's own node_modules/electron/dist/Electron.app — app.setName()
// can't override them. A packaged build sets these via electron-builder
// extendInfo, so this only matters for `npm run dev` / a fresh `npm install`.
//
// Wired as `predev` so it runs before every dev launch, and from
// ensure-electron.mjs so preview/E2E/postinstall get the same keys after the
// binary is downloaded. Idempotent; a no-op off macOS or when the bundle is
// missing.
//
// Mutating Info.plist invalidates Electron's Developer ID signature. TCC then
// has nothing to attach a Local Network grant to, so we ad-hoc re-sign the
// outer app (preserving JIT entitlements; nested frameworks stay as shipped).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NS_LOCAL_NETWORK_USAGE_DESCRIPTION,
  NS_LOCAL_NETWORK_USAGE_KEY
} from './macos-info.mjs';

const NAME = 'Stem';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export function electronDevPaths(root = repoRoot) {
  const app = resolve(root, 'node_modules/electron/dist/Electron.app');
  return { app, plist: resolve(app, 'Contents/Info.plist') };
}

/** Set string keys on a plist, adding any that are missing. */
export function applyPlistKeys(plist, entries) {
  const pb = (cmd) => execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist], { stdio: 'pipe' });
  for (const [key, value] of Object.entries(entries)) {
    try {
      pb(`Set :${key} ${value}`);
    } catch {
      pb(`Add :${key} string ${value}`);
    }
  }
}

/** Ad-hoc sign so TCC can identify the bundle after the plist edit. */
export function adhocSignApp(app) {
  // Unzipped Electron.app often carries Finder xattrs; codesign refuses those
  // with "resource fork, Finder information, or similar detritus not allowed".
  try {
    execFileSync('xattr', ['-cr', app], { stdio: 'pipe' });
  } catch {
    // xattr missing, or nothing to clear
  }
  execFileSync(
    'codesign',
    ['--force', '--sign', '-', '--timestamp=none', '--preserve-metadata=entitlements,flags,runtime', app],
    { stdio: 'pipe' }
  );
}

export function brandDevElectron(root = repoRoot) {
  if (process.platform !== 'darwin') return { skipped: 'not-darwin' };
  const { app, plist } = electronDevPaths(root);
  if (!existsSync(plist)) return { skipped: 'missing-bundle' };
  applyPlistKeys(plist, {
    CFBundleName: NAME,
    CFBundleDisplayName: NAME,
    [NS_LOCAL_NETWORK_USAGE_KEY]: NS_LOCAL_NETWORK_USAGE_DESCRIPTION
  });
  adhocSignApp(app);
  return { app, plist };
}

const invokedAs = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedAs && fileURLToPath(import.meta.url) === invokedAs) {
  const result = brandDevElectron();
  if (!result.skipped) console.log(`Branded dev Electron bundle as "${NAME}".`);
}
