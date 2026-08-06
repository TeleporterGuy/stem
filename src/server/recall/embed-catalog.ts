import type { EmbedKind } from './embeddings';
import type { EmbeddingsSettings, LocalEmbedModelId } from '../../shared/types';

// Curated specs for the bundled local embedding backend. Pure data + string
// helpers (no Electron imports) so the catalog is unit-testable and shareable
// with the utility-process worker. Each entry is a known-good ONNX build on the
// Hugging Face hub, verified to download anonymously; dims and prompt prefixes
// come from the upstream model cards, so don't edit them independently.

export interface LocalEmbedModelSpec {
  id: LocalEmbedModelId;
  /** HF repo with transformers.js-compatible ONNX weights. */
  repo: string;
  dim: number;
  /** Quantization passed to transformers.js `dtype`. */
  dtype: 'q8' | 'q4' | 'fp32';
  approxSizeMB: number;
  /** UI display name. */
  label: string;
  /** Training-time prompt prefixes; prepended verbatim per EmbedKind. */
  prefixes: Record<EmbedKind, string>;
}

export const EMBED_CATALOG: Record<LocalEmbedModelId, LocalEmbedModelSpec> = {
  'multilingual-e5-small': {
    id: 'multilingual-e5-small',
    repo: 'Xenova/multilingual-e5-small',
    dim: 384,
    dtype: 'q8',
    approxSizeMB: 120,
    label: 'Multilingual E5 Small',
    prefixes: { query: 'query: ', passage: 'passage: ' }
  },
  'multilingual-e5-base': {
    id: 'multilingual-e5-base',
    repo: 'Xenova/multilingual-e5-base',
    dim: 768,
    dtype: 'q8',
    approxSizeMB: 280,
    label: 'Multilingual E5 Base',
    prefixes: { query: 'query: ', passage: 'passage: ' }
  },
  'embeddinggemma-300m': {
    id: 'embeddinggemma-300m',
    repo: 'onnx-community/embeddinggemma-300m-ONNX',
    dim: 768,
    // q4, NOT q8: every Gemma variant ships weights as an external .onnx_data
    // file, and the q8 one (305 MB) reliably crashes onnxruntime inside an
    // Electron utilityProcess ("mutex lock failed" abort) while q4 (197 MB)
    // loads and embeds fine. Same abort reproduces in a bare harness, so treat
    // this as an ORT/Electron limit, not an app bug.
    dtype: 'q4',
    approxSizeMB: 200,
    label: 'EmbeddingGemma 300M',
    prefixes: { query: 'task: search result | query: ', passage: 'title: none | text: ' }
  }
};

export const DEFAULT_LOCAL_EMBED_MODEL: LocalEmbedModelId = 'multilingual-e5-small';

/**
 * Vector-cache key for a local model. The `local:` namespace keeps it disjoint
 * from remote server model ids, so switching HTTP↔local can never silently
 * reuse vectors produced by a different model.
 */
export function localModelCacheKey(spec: LocalEmbedModelSpec): string {
  return `local:${spec.repo}`;
}

/** Prepend the model's training-time prefix for this kind to every text. */
export function applyPrefixes(spec: LocalEmbedModelSpec, kind: EmbedKind, texts: string[]): string[] {
  const prefix = spec.prefixes[kind];
  return texts.map((t) => prefix + t);
}

/**
 * The model id that keys the vector cache under the current settings: the local
 * cache key, the remote server's model id, or '' when embeddings are off.
 */
export function effectiveEmbedModelKey(s: EmbeddingsSettings): string {
  if (s.mode === 'local') return localModelCacheKey(EMBED_CATALOG[s.localModel]);
  if (s.mode === 'remote') return s.model;
  return '';
}
