#!/usr/bin/env node
// Run Stem on Linux from any machine with Docker (a Mac included), in the
// container tests/linux/Dockerfile describes.
//
//   node scripts/linux-test.mjs [test] [playwright args]   the E2E suite under Xvfb
//   node scripts/linux-test.mjs desktop                    Stem on a Linux desktop:
//                                                           open http://localhost:6080/vnc.html
//   node scripts/linux-test.mjs shell                      a shell in the same container
//
// e.g. `node scripts/linux-test.mjs test tests/e2e/browser-live.spec.ts`.
//
// The repo is mounted as it is on disk, so uncommitted work is what gets
// tested. node_modules, dist and the browsers live in Docker volumes (Linux
// builds of the native modules); the first run spends a few minutes on
// `npm ci`, later runs only when package-lock.json changed.
//
// On this Mac, a docker command that just sits there is the locked login
// keychain, not the network (see the Docker notes in the memory).

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'stem-linux-test';
const [mode = 'test', ...rest] = process.argv.slice(2);
const known = ['test', 'desktop', 'shell'];
const cmd = known.includes(mode) ? [mode, ...rest] : ['test', mode, ...rest];

function run(args, opts = {}) {
  const r = spawnSync('docker', args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run(['build', '-q', '-t', IMAGE, join(repo, 'tests/linux')], { stdio: ['ignore', 'ignore', 'inherit'] });

const interactive = cmd[0] === 'shell' || cmd[0] === 'desktop';
run([
  'run',
  '--rm',
  '--init',
  ...(interactive && process.stdin.isTTY ? ['-it'] : []),
  ...(cmd[0] === 'desktop' ? ['--name', 'stem-linux-desktop', '-p', '127.0.0.1:6080:6080'] : []),
  // Electron's and Chromium's sandboxes need user namespaces, which Docker's
  // default seccomp profile refuses. A test container, not a place to keep secrets.
  '--security-opt', 'seccomp=unconfined',
  '--shm-size', '1g',
  '-v', `${repo}:/repo`,
  '-v', 'stem-linux-node-modules:/repo/node_modules',
  '-v', 'stem-linux-dist:/repo/dist',
  '-v', 'stem-linux-playwright:/home/node/.cache/ms-playwright',
  '-v', 'stem-linux-npm:/home/node/.npm',
  '-e', 'STEM_E2E_BROWSER=/usr/bin/chromium',
  '-e', 'CI=1',
  IMAGE,
  ...cmd
]);
