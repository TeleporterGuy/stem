import {
  search as storeSearch,
  dbHandle,
  factTermSearch,
  factTrigramSearch,
  type SearchHit,
  type SearchOptions,
  type Fact
} from './store';
import {
  buildMatchQuery as coreBuildMatchQuery,
  buildTrigramQuery,
  hybridSearchMessages,
  type EmbedQueryFn,
  type QueryEmbedding
} from './search-core';

// The stable retrieval interface. Everything in the MAIN process that recalls
// past conversation goes through here; the mechanics live in search-core.ts,
// which is shared verbatim with the standalone recall MCP server — behavior
// changes belong there so both processes stay in lockstep.

export {
  RRF_K,
  FTS_CANDIDATES,
  SEMANTIC_CANDIDATES,
  FTS_SCORE_CEILING
} from './search-core';
export type { QueryEmbedding } from './search-core';

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression. Each word becomes a
 * quoted term (so punctuation/operators can never break MATCH syntax) and the
 * terms are OR-ed, which is the right recall-oriented default. Returns null when
 * there's nothing searchable.
 */
export function buildMatchQuery(raw: string): string | null {
  return coreBuildMatchQuery(raw);
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
  return hybridSearchMessages(dbHandle(), rawQuery, {
    limit: options.limit ?? 5,
    excludeThreadId: options.excludeThreadId,
    embedQuery: options.getQueryEmbedding as EmbedQueryFn | undefined,
    timingSink: options.timingSink
  });
}

export type { SearchHit } from './store';
