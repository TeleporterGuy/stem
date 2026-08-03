import { getEmbeddingsClient } from '../recall/retrieval';
import { dot, magnitude } from '../recall/vector';
import { ensureSkillVectors, skillVectorText, type SkillEmbedder, type SkillVectorInput } from './vectors';

// Write-time near-duplicate check, mirroring `DEFAULT_DUP_COSINE` in
// recall/store.ts. Skills accumulate duplicates faster than facts do, because two
// people describing the same procedure a month apart will not pick the same name:
// the library this replaces had several entries covering the same task under
// different slugs, and the periodic curator merging them after the fact was always
// the second-best moment to notice.
//
// Catching it at write time is better for a reason the curator can't match: the
// caller is still holding the draft, so the answer can be "update THAT one" and be
// acted on immediately, with the new evidence folded into the skill that already
// has the usage history.
//
// Runs on creates only. An update names its target explicitly, and resembling the
// skill you are updating is not a defect.

/**
 * Same value as recall's fact dedup, calibrated against the same embedder. Set
 * high on purpose: two genuinely different procedures for related tasks ("open a
 * video", "read a video's captions") sit well below it, and the cost of a false
 * positive here — refusing a skill that should exist — is worse than the cost of a
 * near-duplicate the curator will merge later.
 */
export const SKILL_DUP_COSINE = 0.94;

export interface DuplicateHit {
  slug: string;
  cosine: number;
}

/**
 * The existing skill this draft would duplicate, or null. Best-effort: with no
 * embeddings available it returns null rather than blocking the write — a missed
 * duplicate is a tidy-up job, a blocked save is lost work.
 */
export async function findDuplicateSkill(
  draft: { name: string; description: string },
  records: SkillVectorInput[],
  embeddings = getEmbeddingsClient()
): Promise<DuplicateHit | null> {
  const others = records.filter((r) => r.slug !== draft.name);
  if (!embeddings || others.length === 0) return null;
  try {
    if (!(await embeddings.available())) return null;
    const model = await embeddings.modelId();
    if (!model) return null;
    const embedder: SkillEmbedder = { model, embed: (texts) => embeddings.embed(texts, 'passage') };
    const vectors = await ensureSkillVectors(others, embedder);
    const [vec] = await embedder.embed([skillVectorText({ slug: draft.name, ...draft })]);
    if (!vec) return null;

    const mag = magnitude(vec) || 1;
    let best: DuplicateHit | null = null;
    for (const record of others) {
      const other = vectors.get(record.slug);
      if (!other || other.length !== vec.length) continue;
      const cosine = dot(vec, other) / (mag * (magnitude(other) || 1));
      if (cosine >= SKILL_DUP_COSINE && (!best || cosine > best.cosine)) best = { slug: record.slug, cosine };
    }
    return best;
  } catch {
    return null;
  }
}
