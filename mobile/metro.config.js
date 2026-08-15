// Metro, taught about one folder outside this project: ../src/shared.
//
// The phone is a client of the same server the desktop talks to, so it must agree
// with it about what a ChatSummary is, what a BackendEventEnvelope carries, and
// which backend methods settle a turn. There is exactly one way to guarantee that
// and it is to import the same files — a copy under mobile/ would be correct on
// the day it was made and quietly wrong on the day after.
//
// Two mechanisms, because they answer different questions. `watchFolders` is what
// lets Metro READ a file that lives above the project root (and rebuild when it
// changes); `extraNodeModules` is what makes the specifier `@shared/x` point at
// it. tsconfig `paths` covers the same mapping for tsc, and Expo's Metro resolver
// reads those too — extraNodeModules is here so the mapping survives even if that
// resolver feature is ever turned off, since a missing alias fails at bundle time
// on a phone rather than at typecheck time on a desk.

/* global require, module, __dirname -- CommonJS: Metro loads its config with require(), not import. */

const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '..', 'src', 'shared');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedRoot];
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@shared': sharedRoot
};
// mobile/ has its own node_modules and deliberately does NOT share the repo
// root's (that tree is Electron's, down to a second copy of React). Pinning the
// lookup here is what keeps a stray hoisted package from being resolved.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

module.exports = config;
