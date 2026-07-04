import type { LocalRerankModelId } from '../../shared/types';

// Curated specs for the bundled local reranker (cross-encoder) backend. Pure
// data (no Electron imports) so it's unit-testable and shareable with the
// utility-process worker, mirroring embed-catalog.ts. Each entry is a known-good
// ONNX build on the Hugging Face hub with a transformers.js-standard layout.

export interface LocalRerankModelSpec {
  id: LocalRerankModelId;
  /** HF repo with transformers.js-compatible ONNX sequence-classification weights. */
  repo: string;
  /** Quantization passed to transformers.js `dtype`. */
  dtype: 'q8' | 'q4' | 'fp32';
  approxSizeMB: number;
  /** UI display name. */
  label: string;
}

export const RERANK_CATALOG: Record<LocalRerankModelId, LocalRerankModelSpec> = {
  // Multilingual cross-encoder (XLM-R based). Verified 2026-07-04 against the
  // live fact set: promotes the cross-lingual (Slovak query → English facts)
  // matches that cosine ranking misses, ~22 ms/pair on an M4 Max at q8.
  // NOTE: onnx-community/gte-multilingual-reranker-base is NOT an alternative —
  // its custom `model_type: "new"` is unsupported by transformers.js.
  'bge-reranker-v2-m3': {
    id: 'bge-reranker-v2-m3',
    repo: 'onnx-community/bge-reranker-v2-m3-ONNX',
    dtype: 'q8',
    approxSizeMB: 570,
    label: 'BGE Reranker v2 M3'
  }
};

export const DEFAULT_LOCAL_RERANK_MODEL: LocalRerankModelId = 'bge-reranker-v2-m3';
