import {
  search as storeSearch,
  factTermSearch,
  factTrigramSearch,
  getSemanticMinCosine,
  hasMessageVectors,
  semanticSearchMessages,
  type SearchHit,
  type SearchOptions,
  type SemanticHit,
  type Fact
} from './store';

// The stable retrieval interface. Everything that recalls past conversation goes
// through here, so a future semantic/embeddings layer can slot in behind
// `searchMemory` without touching callers (auto-inject + the MCP tool).

// Very common words carry no signal and only dilute bm25 ranking. Kept small and
// multilingual-ish (EN/SK/DE) since the user mixes languages.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'for',
  'with', 'that', 'this', 'it', 'i', 'you', 'we', 'my', 'me', 'do', 'does', 'did', 'what', 'who',
  'when', 'where', 'why', 'how', 'about',
  'a', 'aby', 'ako', 'ale', 'som', 'si', 'sa', 'na', 'je', 'to', 'co', 'čo', 'ktorý', 'kde',
  'der', 'die', 'das', 'und', 'ich', 'ist', 'für', 'mit', 'was', 'wie'
]);

/** Lowercase word/number tokens of at least `minLen` chars, stopwords removed, deduped. */
function lexTokens(raw: string, minLen: number): string[] {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length >= minLen && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** OR together quoted FTS5 string terms (escaping embedded quotes). Null when empty. */
function quotedOr(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression. Each word becomes a
 * quoted term (so punctuation/operators can never break MATCH syntax) and the
 * terms are OR-ed, which is the right recall-oriented default. Returns null when
 * there's nothing searchable.
 */
export function buildMatchQuery(raw: string): string | null {
  return quotedOr(lexTokens(raw, 2));
}

/**
 * MATCH expression for the trigram index. Trigram tokens must be ≥ 3 chars; each
 * quoted term becomes a substring search, OR-ed. Null when nothing qualifies.
 */
function buildTrigramQuery(raw: string): string | null {
  return quotedOr(lexTokens(raw, 3));
}

// Recency blend for the lexical fact tier. The weight is deliberately small versus
// typical bm25 magnitudes so recency only breaks near-ties between comparably strong
// lexical matches — it never overrides a clearly stronger match.
const FACT_RECENCY_HALF_LIFE_DAYS = 30;
const FACT_RECENCY_WEIGHT = 0.3;

/** Exponential recency decay in [0,1]: 1 for a just-touched fact, →0 for old ones. */
export function recencyWeight(ageDays: number): number {
  return Math.exp(-Math.max(0, ageDays) / FACT_RECENCY_HALF_LIFE_DAYS);
}

/**
 * Lexical (BM25) relevance ranking of durable facts against a raw user message —
 * the no-embeddings fallback tier. Exact term matches rank first (bm25, with a mild
 * recency blend so near-ties prefer fresher facts); trigram substring matches
 * (inflected/partial forms the term index misses) fill any remaining room. Returns
 * up to `limit` facts, best first; empty when the query has no searchable terms or
 * nothing matches — callers then fall back to recency.
 */
export function rankFactsLexically(rawQuery: string, limit: number, nowSec?: number): Fact[] {
  if (limit <= 0) return [];
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const ranked: Fact[] = [];
  const seen = new Set<number>();

  const termMatch = buildMatchQuery(rawQuery);
  if (termMatch) {
    // Pull a pool wider than `limit`, then re-sort with the recency blend folded in.
    factTermSearch(termMatch, Math.max(limit * 4, limit))
      .map((f) => ({ f, blended: f.score - FACT_RECENCY_WEIGHT * recencyWeight((now - f.updatedAt) / 86400) }))
      .sort((a, b) => a.blended - b.blended)
      .forEach(({ f }) => {
        if (seen.has(f.id)) return;
        seen.add(f.id);
        ranked.push(f);
      });
  }

  if (ranked.length < limit) {
    const trigMatch = buildTrigramQuery(rawQuery);
    if (trigMatch) {
      for (const f of factTrigramSearch(trigMatch, limit)) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        ranked.push(f);
        if (ranked.length >= limit) break;
      }
    }
  }

  return ranked.slice(0, limit);
}

/**
 * Search past conversations for text relevant to `rawQuery`. Returns [] when the
 * query has no searchable terms or nothing matches — callers degrade silently.
 */
export function searchMemory(rawQuery: string, options: SearchOptions = {}): SearchHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  try {
    return storeSearch(match, options);
  } catch {
    // A malformed index / unexpected SQL error must never break a turn.
    return [];
  }
}

// ---- hybrid episodic retrieval (FTS + semantic, reciprocal rank fusion) ----

export const RRF_K = 60;
export const FTS_CANDIDATES = 12;
export const SEMANTIC_CANDIDATES = 12;
/**
 * bm25 noise gate for the FTS leg (scores are negative; more-negative = better).
 * Lives here — not on the fused output — because RRF scores aren't bm25: each leg
 * filters its own noise BEFORE fusion, so a garbage leg can never mint a hit.
 */
export const FTS_SCORE_CEILING = -0.1;

/** A query embedding plus the model that keys the message-vector cache. */
export interface QueryEmbedding {
  vec: Float32Array;
  model: string;
}

export interface HybridOptions extends SearchOptions {
  /**
   * Lazy query-embed thunk (memoized by the caller so fact ranking and episodic
   * search share one embed per turn). Absent/null result/throw → FTS-only.
   */
  getQueryEmbedding?: () => Promise<QueryEmbedding | null>;
  /** Optional sink: wall time of the semantic leg (cosine scan + fusion), ms. */
  timingSink?: { semantic?: number };
}

/**
 * Hybrid episodic search: the FTS leg (bm25-gated) fused with a cosine leg over
 * the cached message vectors via reciprocal rank fusion. When the semantic leg is
 * unavailable (embeddings off/not-ready/erroring) the result is exactly the gated
 * FTS ranking — the zero-regression path. Output `score` is the RRF score
 * (higher = better, unlike bm25); `ftsScore`/`cosine` carry the per-leg evidence.
 */
export async function searchMemoryHybrid(rawQuery: string, options: HybridOptions = {}): Promise<SearchHit[]> {
  const limit = options.limit ?? 5;
  const fts = searchMemory(rawQuery, {
    limit: FTS_CANDIDATES,
    excludeThreadId: options.excludeThreadId
  }).filter((h) => h.score <= FTS_SCORE_CEILING);

  let sem: SemanticHit[] = [];
  if (options.getQueryEmbedding && hasMessageVectors()) {
    const semStart = Date.now();
    try {
      const qe = await options.getQueryEmbedding();
      if (qe) {
        sem = semanticSearchMessages(qe.vec, qe.model, {
          limit: SEMANTIC_CANDIDATES,
          minCosine: getSemanticMinCosine(),
          excludeThreadId: options.excludeThreadId
        });
      }
    } catch {
      // The semantic leg is optional; a dead embedder must never break a turn.
    }
    if (options.timingSink) options.timingSink.semantic = Date.now() - semStart;
  }
  if (sem.length === 0) return fts.slice(0, limit);

  const merged = new Map<number, SearchHit>();
  const rrf = new Map<number, number>();
  for (const list of [fts, sem]) {
    list.forEach((hit, i) => {
      rrf.set(hit.id, (rrf.get(hit.id) ?? 0) + 1 / (RRF_K + i + 1));
      const prior = merged.get(hit.id);
      if (!prior) {
        // First sighting: keep the leg's hit (FTS hits carry the real snippet).
        merged.set(hit.id, { ...hit, ftsScore: 'cosine' in hit ? undefined : hit.score, cosine: (hit as SemanticHit).cosine });
      } else {
        // Seen by both legs — graft the other leg's evidence onto the FTS hit.
        prior.cosine = prior.cosine ?? (hit as SemanticHit).cosine;
      }
    });
  }
  return [...merged.values()]
    .map((hit) => ({ ...hit, score: rrf.get(hit.id) ?? 0 }))
    .sort((a, b) => b.score - a.score || b.ts - a.ts)
    .slice(0, limit);
}

export type { SearchHit } from './store';
