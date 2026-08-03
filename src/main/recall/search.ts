
import {
  buildMatchQuery as coreBuildMatchQuery,
  buildTrigramQuery,
  FTS_SCORE_CEILING,
  hybridSearchMessages,
  type EmbedQueryFn,
  type QueryEmbedding
} from './search-core';
import { scanMessagesOffThread } from './scan';
import { recallStore, type SearchHit, type SearchOptions, type Fact } from './store';
const { search: storeSearch, countActiveFacts, dbHandle, factTermSearch, factTrigramSearch } = recallStore;

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
 * A sensitive fact on the lexical tier needs a materially strong term match, not
 * just any token overlap — the counterpart of its stricter 0.82 cosine gate on
 * the semantic tier (inject.ts). Well below the -0.1 noise ceiling.
 */
export const SENSITIVE_LEXICAL_MAX_BM25 = -1;

/**
 * Below this many active facts both lexical bm25 gates are skipped: bm25
 * magnitudes scale with IDF, and in a small store every score collapses toward
 * 0 — the same scale-awareness as ftsSearchDocs' DOC_FTS_GATE_MIN_DOCS. The
 * one-incidental-shared-word leak the gates exist for is a large-store
 * phenomenon; in a 20-fact store a term match IS a direct match.
 */
export const FACT_LEXICAL_GATE_MIN_FACTS = 32;

/**
 * Lexical (BM25) relevance ranking of durable facts against a raw user message —
 * the no-embeddings fallback tier. Exact term matches rank first (bm25-gated like
 * every other FTS leg, with a mild recency blend so near-ties prefer fresher
 * facts); trigram substring matches (inflected/partial forms the term index
 * misses) fill any remaining room. Sensitivity keeps a stricter bar here too:
 * sensitive facts need a strong bm25 match and never ride the trigram fill,
 * whose recency ordering carries no relevance signal at all. Returns up to
 * `limit` facts, best first; empty when the query has no searchable terms or
 * nothing matches — callers then fall back to recency.
 */
export function rankFactsLexically(rawQuery: string, limit: number, nowSec?: number): Fact[] {
  if (limit <= 0) return [];
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const ranked: Fact[] = [];
  const seen = new Set<number>();

  const termMatch = buildMatchQuery(rawQuery);
  if (termMatch) {
    const gated = countActiveFacts() >= FACT_LEXICAL_GATE_MIN_FACTS;
    // Pull a pool wider than `limit`, then re-sort with the recency blend folded in.
    factTermSearch(termMatch, Math.max(limit * 4, limit))
      .filter((f) => !gated || f.score <= FTS_SCORE_CEILING)
      .filter((f) => f.sensitivity !== 'sensitive' || !gated || f.score <= SENSITIVE_LEXICAL_MAX_BM25)
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
        if (seen.has(f.id) || f.sensitivity === 'sensitive') continue;
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
    // The O(N) cosine scan runs in the scan worker when available, keeping the
    // chat-turn hot path off the main event loop (in-process fallback inside).
    semanticScan: scanMessagesOffThread,
    timingSink: options.timingSink
  });
}

export type { SearchHit } from './store';
