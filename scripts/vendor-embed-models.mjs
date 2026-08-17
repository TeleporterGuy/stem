#!/usr/bin/env node
// Pack Stem's downloaded embedding weights into vendor/embed-models/ so a
// clone can load them without Hugging Face. GitHub rejects files over 100 MB
// and warns above 50 MB, so each ONNX is gzipped and split into 45 MB parts.
//
//   npm run vendor:embed-models [sourceDir]
//
// Default source is this machine's Stem cache (override with STEM_EMBED_MODELS_DIR).
// Stem unpacks the parts into the app cache on first launch.
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PART_BYTES = 45 * 1024 * 1024;
const GZIP_FROM_BYTES = 10 * 1024 * 1024;
const root = fileURLToPath(new URL('..', import.meta.url));
const destRoot = join(root, 'vendor', 'embed-models');

function defaultCache() {
  if (process.env.STEM_EMBED_MODELS_DIR) return process.env.STEM_EMBED_MODELS_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Stem', 'embed-models');
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Stem', 'embed-models');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Stem', 'embed-models');
}

function walkFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

function shouldGzip(file, size) {
  const lower = file.toLowerCase();
  return lower.endsWith('.onnx') || lower.endsWith('.onnx_data') || size >= GZIP_FROM_BYTES;
}

async function gzipFile(src, destGz) {
  mkdirSync(dirname(destGz), { recursive: true });
  const tmp = `${destGz}.tmp`;
  await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(tmp));
  const size = statSync(tmp).size;
  if (size <= PART_BYTES) {
    renameSync(tmp, destGz);
    console.log(`  packed ${relative(destRoot, destGz)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    return;
  }
  const fd = openSync(tmp, 'r');
  let offset = 0;
  let i = 0;
  const buf = Buffer.alloc(PART_BYTES);
  while (offset < size) {
    const n = readSync(fd, buf, 0, PART_BYTES, offset);
    const part = `${destGz}.${String(i).padStart(2, '0')}`;
    writeFileSync(part, buf.subarray(0, n));
    console.log(`  packed ${relative(destRoot, part)} (${(n / 1024 / 1024).toFixed(1)} MB)`);
    offset += n;
    i += 1;
  }
  closeSync(fd);
  unlinkSync(tmp);
}

const source = process.argv[2] || defaultCache();
if (!existsSync(source)) {
  console.error(`No embedding cache at ${source}\nRun Stem once on a machine that can reach huggingface.co, then retry.`);
  process.exit(1);
}

const files = walkFiles(source);
if (!files.length) {
  console.error(`${source} has no model files yet.`);
  process.exit(1);
}

mkdirSync(destRoot, { recursive: true });
for (const abs of files) {
  const rel = relative(source, abs);
  const size = statSync(abs).size;
  if (shouldGzip(abs, size)) {
    await gzipFile(abs, join(destRoot, `${rel}.gz`));
  } else {
    const dest = join(destRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    console.log(`  copied ${rel}`);
  }
}
console.log(`OK → ${destRoot}`);
