#!/usr/bin/env node
// Copy Stem's downloaded embedding/reranker weights into vendor/embed-models/
// so a clone can load them without Hugging Face (company laptops, air-gap).
//
//   node scripts/vendor-embed-models.mjs [sourceDir]
//
// Default source is this machine's Stem cache (override with STEM_EMBED_MODELS_DIR).
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dest = join(root, 'vendor', 'embed-models');

function defaultCache() {
  if (process.env.STEM_EMBED_MODELS_DIR) return process.env.STEM_EMBED_MODELS_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Stem', 'embed-models');
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Stem', 'embed-models');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Stem', 'embed-models');
}

const source = process.argv[2] || defaultCache();
if (!existsSync(source)) {
  console.error(`No embedding cache at ${source}\nRun Stem once on a machine that can reach huggingface.co, then retry.`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
let copied = 0;
for (const name of readdirSync(source, { withFileTypes: true })) {
  if (!name.isDirectory() || name.name.startsWith('.')) continue;
  cpSync(join(source, name.name), join(dest, name.name), { recursive: true });
  copied += 1;
  console.log(`copied ${name.name}/`);
}
if (!copied) {
  console.error(`${source} has no model folders yet.`);
  process.exit(1);
}
console.log(`OK → ${dest}`);
