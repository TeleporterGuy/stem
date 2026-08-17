import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
