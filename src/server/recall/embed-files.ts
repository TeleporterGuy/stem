import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { LocalEmbedModelSpec } from './embed-catalog';

// Helpers for finding ONNX weights on disk and deciding whether the worker
// may call Hugging Face. Kept free of transformers.js so they are unit-testable
// and shareable with the manager (which only passes paths, not env flags).

export type EmbedDtype = LocalEmbedModelSpec['dtype'];

/** The weights filename transformers.js resolves for each catalog dtype. */
export function weightsFile(dtype: EmbedDtype): string {
  return dtype === 'q8' ? 'model_quantized.onnx' : dtype === 'q4' ? 'model_q4.onnx' : 'model.onnx';
}

/**
 * True when `root` already holds the ONNX file transformers.js would load for
 * this repo+dtype. Layout matches the Hugging Face cache:
 * `{root}/{repo}/onnx/model_quantized.onnx` (or model_q4.onnx / model.onnx).
 */
export function weightsPresent(root: string, repo: string, dtype: EmbedDtype): boolean {
  try {
    return existsSync(join(root, repo, 'onnx', weightsFile(dtype)));
  } catch {
    return false;
  }
}

/**
 * Whether the worker should talk to the Hub, and which extra local root to
 * point transformers.js at.
 *
 * - Weights already in the userData cache → stay offline (a copied cache from
 *   another machine must not re-check huggingface.co).
 * - Weights in the repo-shipped vendor dir → same, and set `localModelPath`.
 * - Neither → download into cacheDir as before.
 */
export function hubAccessForLoad(opts: {
  cacheDir: string;
  bundledDir?: string | null;
  repo: string;
  dtype: EmbedDtype;
}): { allowRemoteModels: boolean; localModelPath: string | null } {
  const bundled =
    opts.bundledDir && weightsPresent(opts.bundledDir, opts.repo, opts.dtype) ? opts.bundledDir : null;
  const cached = weightsPresent(opts.cacheDir, opts.repo, opts.dtype);
  return {
    allowRemoteModels: !cached && !bundled,
    localModelPath: bundled
  };
}

/**
 * ONNX error text often uses the other slash than `path.join` on this OS.
 * Match either so a truncated Windows download still counts as "our" file.
 */
export function pathAppearsInMessage(message: string, filePath: string): boolean {
  if (message.includes(filePath)) return true;
  const forward = filePath.replaceAll('\\', '/');
  const back = filePath.replaceAll('/', '\\');
  return message.includes(forward) || message.includes(back);
}

/** Keep each git object under GitHub's 50 MB warning (hard cap is 100 MB). */
export const PACK_PART_BYTES = 45 * 1024 * 1024;

const GZ_PART = /\.gz\.(\d{2})$/;

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

function packedOnnxGroups(bundledDir: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const abs of walkFiles(bundledDir)) {
    const rel = relative(bundledDir, abs);
    if (rel === 'README.md') continue;
    const part = GZ_PART.exec(rel);
    if (part) {
      const base = rel.slice(0, -part[0].length); // strip .gz.00
      const list = groups.get(base) ?? [];
      list.push(abs);
      groups.set(base, list);
      continue;
    }
    if (rel.endsWith('.gz')) {
      const base = rel.slice(0, -3);
      const list = groups.get(base) ?? [];
      list.push(abs);
      groups.set(base, list);
    }
  }
  for (const [, parts] of groups) {
    parts.sort((a, b) => a.localeCompare(b));
  }
  return groups;
}

/**
 * Copy vendor sidecars (tokenizer, config) and gunzip packed ONNX weights into
 * the userData cache. No-op when the cache already has the unpacked file.
 * Packed layout: `model_quantized.onnx.gz` or split `…gz.00`, `…gz.01`, …
 */
export async function unpackBundledEmbedModels(bundledDir: string, cacheDir: string): Promise<number> {
  if (!existsSync(bundledDir)) return 0;
  let unpacked = 0;

  for (const abs of walkFiles(bundledDir)) {
    const rel = relative(bundledDir, abs);
    if (rel === 'README.md' || rel.endsWith('.gz') || GZ_PART.test(rel)) continue;
    const dest = join(cacheDir, rel);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    unpacked += 1;
  }

  for (const [relBase, parts] of packedOnnxGroups(bundledDir)) {
    const dest = join(cacheDir, relBase);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    try {
      await pipeline(
        Readable.from(
          (async function* () {
            for (const part of parts) {
              for await (const chunk of createReadStream(part)) yield chunk;
            }
          })()
        ),
        createGunzip(),
        createWriteStream(tmp)
      );
      renameSync(tmp, dest);
      unpacked += 1;
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // leftover tmp is harmless; next launch retries
      }
      throw err;
    }
  }
  return unpacked;
}
