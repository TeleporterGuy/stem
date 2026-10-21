import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { degrade } from '../degrade';
import { skillsRoot } from '../workspace/paths';

// Embedding cache for skill retrieval, kept in a sidecar JSON at the root of the
// skills dir next to `.skills-usage.json`. The same reasoning applies as there:
// this must NOT live in SKILL.md front-matter, because every SKILL.md write bumps
// `.skills-rev` and forces a backend reload — and a vector refresh is pure
// bookkeeping that must never cost a reload. Top-level dotfiles are invisible to
// pi's scanner, which only descends into directories holding a SKILL.md.
//
// One vector per skill, computed over `name + description` and NOT the body. The
// description is the retrieval surface — it is what the incoming message is
// matched against — and bodies run to 4 KB, so embedding them would multiply the
// cost of every edit for a signal ranking never reads. (It would also blur the
// vector: a body full of tool names drags a skill toward any message mentioning
// those tools, whether or not the procedure applies.)
//
// Two independent invalidations:
//   - `hash` per entry, over the exact embedded text, so editing one description
//     re-embeds one skill.
//   - `model` for the whole file. Vectors from different models live in different
//     spaces and their cosines are meaningless against each other, but nothing
//     about a stale vector *looks* wrong — the failure shows up months later as
//     "retrieval got worse". So a model change throws the file away wholesale.
//
// Like usage, this cache is disposable: losing it costs one round of re-embedding
// and nothing else, so the reader is tolerant and the writer is best-effort.

export const SKILLS_VECTORS_FILE = '.skills-vectors.json';

/** Bumped when the on-disk shape changes; a mismatch discards the file. */
export const SKILL_VECTORS_VERSION = 1;

interface StoredEntry {
  hash: string;
  vector: number[];
}

interface StoredVectors {
  version: number;
  model: string;
  skills: Record<string, StoredEntry>;
}

/** The minimum a record must carry to be embedded — see inject.ts for the full shape. */
export interface SkillVectorInput {
  slug: string;
  name: string;
  description: string;
}

/**
 * The embedding seam. Deliberately narrower than `EmbeddingsClient`: the caller
 * has already resolved availability and the model id (one `modelId()` round-trip
 * per turn, shared with the query embed), and this module needs the id anyway to
 * key the file.
 */
export interface SkillEmbedder {
  model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Exactly what gets embedded — also what `hash` is taken over. */
export function skillVectorText(record: SkillVectorInput): string {
  return `${record.name}\n${record.description}`;
}

function hashText(text: string): string {
  // Truncated SHA-1: this is change detection, not integrity, and a 64-bit prefix
  // over ~25 short strings will not collide.
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function vectorsFile(name = SKILLS_VECTORS_FILE): string {
  return join(skillsRoot(), name);
}

/**
 * Tolerant read: a missing, corrupt, wrong-version or wrong-model file yields an
 * empty cache for `model`, which simply means everything gets re-embedded.
 */
function readVectors(file: string, model: string): StoredVectors {
  const empty: StoredVectors = { version: SKILL_VECTORS_VERSION, model, skills: {} };
  let raw: string;
  try {
    raw = readFileSync(vectorsFile(file), 'utf8');
  } catch {
    // quiet: no file yet is the first turn after a model change or a fresh
    // install, and the whole library is re-embedded either way.
    return empty;
  }
  try {
    const data = JSON.parse(raw) as Partial<StoredVectors> | null;
    if (!data || data.version !== SKILL_VECTORS_VERSION || data.model !== model) return empty;
    const skills: Record<string, StoredEntry> = {};
    for (const [slug, entry] of Object.entries(data.skills ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      const { hash, vector } = entry as Partial<StoredEntry>;
      if (typeof hash !== 'string' || !Array.isArray(vector) || vector.length === 0) continue;
      if (!vector.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      skills[slug] = { hash, vector };
    }
    return { version: SKILL_VECTORS_VERSION, model, skills };
  } catch {
    // quiet: same as a missing file — the cache is derived data and a corrupt
    // one costs exactly one round of re-embedding.
    return empty;
  }
}

function writeVectors(file: string, data: StoredVectors): void {
  try {
    mkdirSync(skillsRoot(), { recursive: true });
    writeFileSync(vectorsFile(file), `${JSON.stringify(data)}\n`, 'utf8');
  } catch {
    // quiet: the cache is an optimization, so a failed write costs a re-embed
    // next turn rather than a broken turn — ranking is unchanged either way.
  }
}

/**
 * The shared cache walk: resolve a vector for every keyed text, embedding only
 * the ones whose text changed (or all of them, when the model changed), persist,
 * and drop keys that were not asked for. A key whose embed failed is absent.
 */
async function ensureKeyedVectors(
  file: string,
  items: Array<{ key: string; text: string }>,
  embedder: SkillEmbedder
): Promise<Map<string, Float32Array>> {
  const cached = readVectors(file, embedder.model);
  const next: Record<string, StoredEntry> = {};
  const stale: Array<{ key: string; text: string; hash: string }> = [];

  for (const item of items) {
    const hash = hashText(item.text);
    const hit = cached.skills[item.key];
    if (hit && hit.hash === hash) next[item.key] = hit;
    else stale.push({ key: item.key, text: item.text, hash });
  }

  if (stale.length > 0) {
    try {
      const vecs = await embedder.embed(stale.map((s) => s.text));
      stale.forEach((s, i) => {
        const vec = vecs[i];
        if (vec) next[s.key] = { hash: s.hash, vector: Array.from(vec) };
      });
    } catch (error) {
      // Embeddings went away mid-refresh. Keep whatever the cache already had —
      // a partially warm map still ranks the skills it covers. But inject.ts
      // treats a missing vector as "not a candidate", so every skill in `stale`
      // — which on the turn after an edit is the edited one — cannot be inlined
      // at all, and nothing downstream can tell that from a poor match.
      degrade('skills.vectors', `left ${stale.length} skill texts unranked this turn`, error);
    }
  }

  // Rewrite only when something actually moved: an unchanged library must not
  // rewrite the file (and churn its mtime) on every turn.
  const changed =
    stale.length > 0 ||
    cached.model !== embedder.model ||
    Object.keys(cached.skills).length !== Object.keys(next).length;
  if (changed) writeVectors(file, { version: SKILL_VECTORS_VERSION, model: embedder.model, skills: next });

  const out = new Map<string, Float32Array>();
  for (const [key, entry] of Object.entries(next)) out.set(key, Float32Array.from(entry.vector));
  return out;
}

/**
 * Resolve a vector for every record, embedding only those whose text changed
 * (or all of them, when the model changed), and persist the result. Entries for
 * skills that no longer exist are dropped in the same pass.
 *
 * Returns the vectors keyed by slug — Float32Array so callers can hand them
 * straight to the `dot`/`magnitude` helpers in `recall/vector`. A record is
 * simply absent from the map if its embed failed.
 */
export async function ensureSkillVectors(
  records: SkillVectorInput[],
  embedder: SkillEmbedder
): Promise<Map<string, Float32Array>> {
  return ensureKeyedVectors(
    SKILLS_VECTORS_FILE,
    records.map((r) => ({ key: r.slug, text: skillVectorText(r) })),
    embedder
  );
}

/**
 * Example requests are embedded on their own, in a file of their own: each is a
 * separate thing a message can resemble (see skills/examples.ts), and keeping
 * them out of `.skills-vectors.json` leaves that file's walk — which dedup and
 * the curator also run over subsets of the library — free to drop them.
 */
export const SKILLS_EXAMPLE_VECTORS_FILE = '.skills-example-vectors.json';

/** Vectors for each skill's example requests, keyed by slug, in example order. */
export async function ensureSkillExampleVectors(
  examples: ReadonlyMap<string, readonly string[]>,
  embedder: SkillEmbedder
): Promise<Map<string, Float32Array[]>> {
  const items: Array<{ key: string; text: string }> = [];
  for (const [slug, list] of examples) list.forEach((text, i) => items.push({ key: `${slug}#${i}`, text }));
  const flat = await ensureKeyedVectors(SKILLS_EXAMPLE_VECTORS_FILE, items, embedder);
  const out = new Map<string, Float32Array[]>();
  for (const [slug, list] of examples) {
    const vecs = list.map((_, i) => flat.get(`${slug}#${i}`)).filter((v): v is Float32Array => !!v);
    if (vecs.length) out.set(slug, vecs);
  }
  return out;
}
