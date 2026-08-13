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
  /**
   * Raw-logit floor below which this model's score means "not relevant", for
   * callers that need a yes/no rather than an ordering (skill inlining). Lives
   * here, next to the weights it was measured against, because it is a property
   * of THIS model and of nothing else — the mistake that put a cosine floor in
   * the ranking logic and left it there across an embedder swap.
   *
   * Only meaningful for the bundled local models: a remote /rerank server runs
   * an arbitrary model on an unknown scale (Cohere-style endpoints normalise to
   * 0..1, this one does not), so remote callers get no floor and must fall back
   * to a scale-free rule.
   */
  minRelevantScore: number;
  /**
   * Raw-logit floor for the fact-injection gate (inject.ts): a durable fact
   * scoring below this against the user's message is noise, not context. A
   * separate number from minRelevantScore because it is a separate measurement:
   * facts ANSWER the query directly (unlike skill descriptions), and the gate is
   * applied to production-style BATCHED scoring, whose padding drift the skill
   * floor explicitly excludes. Same ownership rule: this is a property of THIS
   * model's logit scale and lives next to the weights it was measured against.
   */
  factGateScore: number;
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
    label: 'BGE Reranker v2 M3',
    // Measured 2026-08-10 on tests/fixtures/skill-retrieval-golden.json (20
    // positives / 12 negatives, cosine shortlist of 4, ONE PAIR PER FORWARD
    // PASS — see below):
    //
    //     −7   loaded 0.750   noise 0.000   false-load 0.083
    //     −8   loaded 0.850   noise 0.000   false-load 0.167
    //     −9   loaded 0.950   noise 0.050   false-load 0.250
    //    −10   loaded 0.950   noise 0.100   false-load 0.250
    //
    // −9 rather than the point that minimises total error, because the two
    // errors do not cost the same. A skill that fails to load costs the whole
    // feature — that is the regression this replaced, and it ran for a week. A
    // skill that loads when it should not costs ~2.4 KB and is recoverable: the
    // block instructs the model to say so when a loaded procedure does not fit.
    // Buy recall with false loads here, not the other way round.
    //
    // Deep in the negatives, not near the sigmoid's 0 boundary, because this
    // model scores "does this passage ANSWER the query" and a skill description
    // answers nothing — it says when to reach for a procedure. Every pair
    // therefore lands low; what carries the signal is that non-matches saturate
    // hard at about −11 while a real match lifts several logits clear of it.
    //
    // THIS NUMBER IS ONLY VALID FOR UNBATCHED SCORING. The identical (query,
    // doc) pair scores −7.890 alone, −8.090 in a batch of two and −8.289 in a
    // batch of six: padding to the batch's longest sequence leaks into the
    // logit. Ordering shrugs that off, which is why it went unnoticed in the
    // rerank-for-ranking path, but a 0.4-logit drift straddles any threshold
    // near here. Callers that compare against this MUST score one pair per
    // forward pass. Re-measure with `npm run eval:skill-retrieval -- --rerank`
    // before changing it.
    minRelevantScore: -9,
    // Measured 2026-08-13 on the fact-injection benchmark (recall-bench/: 60
    // real turns, dual-labeled + adjudicated gold, scored with production-style
    // batch-8 forward passes — so unlike minRelevantScore this floor already
    // absorbs padding drift). Sweep over the union candidate pool:
    //
    //    −6   P 0.23  R 0.19  leaks  9/60 turns
    //    −8   P 0.15  R 0.30  leaks 23/60   (+2 sensitive margin → leaks 4)
    //   −10   admits the trigram-fill noise tier this gate exists to kill
    //
    // −8 with the sensitive margin (inject.ts) rather than −6: recall parity
    // with the old fill-to-limit pipeline at 6× its precision, and the margin —
    // not a harsher global floor — is what removes the sensitive-fact leaks.
    // Re-run recall-bench/ (README has the procedure) before changing it.
    factGateScore: -8
  }
};

export const DEFAULT_LOCAL_RERANK_MODEL: LocalRerankModelId = 'bge-reranker-v2-m3';
