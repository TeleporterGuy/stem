// Downloads Electron's binary after `npm install`, restoring what Electron used
// to do for itself.
//
// Electron 42 dropped its install script: `node_modules/electron/package.json`
// has no `scripts` at all. The binary is now fetched lazily, the first time
// something calls `require('electron')` — index.js shells out to install.js from
// getElectronPath(). electron-vite never triggers that path: it resolves the
// module *directory* and reads `path.txt` itself (dist/chunks/lib-*.js), so on a
// fresh clone it finds no path.txt and dies with `Error: Electron uninstall`,
// which names neither electron nor the missing download.
//
// Deliberately never fails the install. A contributor behind a proxy, offline, or
// on a flaky link should still end up with a working node_modules; preflight
// (run by `predev`) is the hard gate, and it prints the one command to re-run.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const electronDir = join(root, 'node_modules', 'electron');
const installer = join(electronDir, 'install.js');

// Production/CI installs that omit devDependencies have no electron to set up.
if (!existsSync(installer)) process.exit(0);

// Same resolution electron's own isInstalled() uses: path.txt holds the
// platform-relative path inside dist/, and both are written by install.js.
const pathTxt = join(electronDir, 'path.txt');
const binary = existsSync(pathTxt) ? join(electronDir, 'dist', readFileSync(pathTxt, 'utf8').trim()) : null;
if (binary && existsSync(binary)) process.exit(0);

console.log('Downloading the Electron binary (~120MB, cached for later installs)…');
const { status, error } = spawnSync(process.execPath, [installer], { stdio: 'inherit' });

if (status !== 0) {
  console.warn(
    `\n  Could not download the Electron binary${error ? ` (${error.message})` : ''}.\n` +
      '  Install completed anyway — re-run this when you have a connection:\n' +
      '    node node_modules/electron/install.js\n'
  );
}
