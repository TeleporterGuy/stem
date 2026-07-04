import type { EmbeddingsClient } from './embeddings';
import {
  getMessageEmbedWatermark,
  getMessagesForEmbedding,
  setMessageEmbedWatermark,
  upsertMessageVector
} from './store';

// Background embedding of captured messages for semantic episodic search.
// Watermark-driven (meta key, model-tagged) and always off the turn path: the
// ready-transition hook and a post-turn debounce in index.ts call embedNewMessages,
// which walks everything past the watermark in batches. The watermark advances
// after each batch, so a crash or embed failure resumes exactly where it stopped.

/**
 * Messages shorter than this carry no retrievable signal ("ok", "thanks", "áno")
 * and only pollute cosine space — skipped, though the watermark still passes them.
 */
export const EPISODIC_EMBED_MIN_CHARS = 20;
/**
 * Embed at most this much of a message. e5's 512-token window is roughly
 * 1200–2000 chars of mixed SK/EN text; the lead-in almost always carries the
 * topic. The stored text is untouched — this bounds only the embedding input.
 */
export const EPISODIC_EMBED_MAX_CHARS = 1500;

/** Deterministic embedding input for a message; null = skip (too short). */
export function episodicEmbedText(text: string): string | null {
  const t = text.trim();
  if (t.length < EPISODIC_EMBED_MIN_CHARS) return null;
  return t.slice(0, EPISODIC_EMBED_MAX_CHARS);
}

// Overlapping kicks (ready-transition + post-turn debounce firing together) must
// not double-embed a batch; one pass at a time, extra kicks no-op.
let running = false;

/**
 * Embed every message past the watermark for the client's current model, in
 * batches. Returns how many vectors were written. Never throws: any failure
 * (embeddings not ready, worker died mid-batch) just ends the pass — the
 * unadvanced watermark makes the next kick retry from the same spot.
 */
export async function embedNewMessages(
  emb: EmbeddingsClient,
  opts: { batchSize?: number } = {}
): Promise<number> {
  if (running) return 0;
  running = true;
  const batchSize = opts.batchSize ?? 64;
  let written = 0;
  try {
    if (!(await emb.available())) return written;
    const model = await emb.modelId();
    if (!model) return written;
    for (;;) {
      const batch = getMessagesForEmbedding(getMessageEmbedWatermark(model), batchSize);
      if (batch.length === 0) break;
      const embeddable = batch
        .map((m) => ({ id: m.id, text: episodicEmbedText(m.text) }))
        .filter((e): e is { id: number; text: string } => e.text !== null);
      if (embeddable.length > 0) {
        const vecs = await emb.embed(
          embeddable.map((e) => e.text),
          'passage'
        );
        embeddable.forEach((e, i) => upsertMessageVector(e.id, model, vecs[i]));
        written += embeddable.length;
      }
      setMessageEmbedWatermark(model, batch[batch.length - 1].id);
    }
  } catch {
    // Embed failure mid-pass: stop here. The watermark only moved past batches
    // that were fully written, so nothing is lost — just deferred.
  } finally {
    running = false;
  }
  return written;
}
