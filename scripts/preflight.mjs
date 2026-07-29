// Turns the two failures that greet a fresh clone into instructions instead of
// stack traces. Both are silent until something far downstream explodes:
//
//  1. Too old a Node. node:sqlite (the recall store) is only flag-free on 24+,
//     so an older runtime dies deep inside the store with a cryptic import error.
//  2. No Electron binary. `postinstall` (scripts/ensure-electron.mjs) downloads
//     it, but never fails the install, so a proxy or an offline machine lands
//     here. Without the binary electron-vite fails with `Error: Electron
//     uninstall`, which names neither electron nor the missing download.
//     (Nothing platform-specific here — it greets a fresh clone on any OS.)
//
// Wired as part of `predev`, and runnable on its own via `npm run preflight`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];

// -- Node version -------------------------------------------------------------
// package.json's `engines` is the single source of truth; npm only warns on it.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const required = Number((pkg.engines?.node ?? '').match(/\d+/)?.[0] ?? 0);
const current = Number(process.versions.node.split('.')[0]);

if (required && current < required) {
  problems.push(
    `Node ${process.versions.node} is too old — Stem needs Node ${required} or newer ` +
      `(node:sqlite, used by the recall store, is only flag-free on ${required}+).\n` +
      `      Install it with nvm (\`nvm install\`, which reads .nvmrc), fnm, mise, or your package manager.`
  );
}

// -- Electron binary ----------------------------------------------------------
const electronDir = join(root, 'node_modules', 'electron');

if (!existsSync(electronDir)) {
  problems.push('Dependencies are not installed — run `npm install` first.');
} else {
  // Mirror how node_modules/electron/index.js resolves the executable: path.txt
  // holds the platform-relative path inside dist/, and both are written by the
  // postinstall. Either one missing means the binary was never unpacked.
  const pathTxt = join(electronDir, 'path.txt');
  const binary = existsSync(pathTxt)
    ? join(electronDir, 'dist', readFileSync(pathTxt, 'utf8').trim())
    : null;

  if (!binary || !existsSync(binary)) {
    problems.push(
      "Electron's binary was never downloaded, so the app cannot launch " +
        '(electron-vite reports this as `Error: Electron uninstall`).\n' +
        '      `npm install` normally fetches it and only warns if it cannot, so this\n' +
        '      usually means the download failed. Re-run it directly:\n' +
        '        node node_modules/electron/install.js'
    );
  }
}

// -----------------------------------------------------------------------------
if (problems.length) {
  console.error(`\n  Stem cannot start — ${problems.length === 1 ? 'one thing needs' : 'these need'} fixing:\n`);
  for (const [i, p] of problems.entries()) console.error(`  ${i + 1}. ${p}\n`);
  process.exit(1);
}
