import type { DatabaseSync } from 'node:sqlite';

// The shared retrieval core: tokenization, FTS match building, cosine scans and
// reciprocal-rank fusion over recall.sqlite — parameterized by a DatabaseSync
// handle so the SAME code serves two processes:
//   - the main process (store.ts / search.ts / inject.ts), read-write handle
//   - the standalone recall MCP server (mcp-server-main.ts), read-only handle
//
// This file must stay electron-free and store-free (no imports beyond
// node:sqlite types): it is bundled into dist/main/recall-mcp-server.js and run
// under ELECTRON_RUN_AS_NODE. Any state it needs (tunables) is read from the
// meta table through the handle it is given.
//
// It replaces the hand-copied duplicate search logic that previously lived in
// mcp-server.mjs — behavior changes here reach both processes by construction.

export type CoreRole = 'user' | 'assistant';

/** One ranked hit; `score` is bm25 on FTS output, cosine on semantic, RRF on hybrid. */
export interface CoreSearchHit {
  id: number;
  threadId: string;
  turnId: string | null;
  role: CoreRole;
  ts: number;
  text: string;
  snippet: string;
  score: number;
  /** Debug evidence on hybrid output: the FTS leg's bm25 score, when FTS saw it. */
  ftsScore?: number;
  /** Debug evidence on hybrid/semantic output: cosine similarity, when the semantic leg saw it. */
  cosine?: number;
}

/** A ranked fact hit (id + text only — the core doesn't know the Fact shape). */
export interface CoreFactHit {
  id: number;
  text: string;
  score: number;
}

/** A ranked thread-summary hit. */
export interface CoreSummaryHit {
  id: number;
  threadId: string;
  text: string;
  firstTs: number;
  lastTs: number;
  score: number;
  ftsScore?: number;
  cosine?: number;
}

/** A query embedding plus the model that keys the vector caches. */
export interface QueryEmbedding {
  vec: Float32Array;
  model: string;
}

/**
 * Lazy query-embed thunk (memoized by the caller so all legs of a turn share
 * one embed). Absent/null result/throw → FTS-only.
 */
export type EmbedQueryFn = () => Promise<QueryEmbedding | null>;

// Very common words carry no signal and only dilute bm25 ranking. Kept small and
// multilingual-ish (EN/SK/DE) since the user mixes languages.
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'for',
  'with', 'that', 'this', 'it', 'i', 'you', 'we', 'my', 'me', 'do', 'does', 'did', 'what', 'who',
  'when', 'where', 'why', 'how', 'about',
  'a', 'aby', 'ako', 'ale', 'som', 'si', 'sa', 'na', 'je', 'to', 'co', 'čo', 'ktorý', 'kde',
  'der', 'die', 'das', 'und', 'ich', 'ist', 'für', 'mit', 'was', 'wie'
]);

/** Lowercase word/number tokens of at least `minLen` chars, stopwords removed, deduped. */
export function lexTokens(raw: string, minLen: number): string[] {
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
export function buildTrigramQuery(raw: string): string | null {
  return quotedOr(lexTokens(raw, 3));
}

export const RRF_K = 60;
export const FTS_CANDIDATES = 12;
export const SEMANTIC_CANDIDATES = 12;
/**
 * bm25 noise gate for the FTS leg (scores are negative; more-negative = better).
 * Applied per-leg BEFORE fusion, because RRF scores aren't bm25: each leg filters
 * its own noise so a garbage leg can never mint a hit.
 */
export const FTS_SCORE_CEILING = -0.1;

/**
 * Floor for semantic-only hits. e5-family similarities squash into roughly
 * [0.7, 1.0], so 0.82 sits above unrelated-content noise while keeping genuine
 * cross-language matches (calibrated by scripts/recall-eval.mjs).
 */
export const DEFAULT_SEMANTIC_MIN_COSINE = 0.82;

/**
 * Floor for semantic summary hits — deliberately LOWER than the message floor:
 * summaries are long multi-topic passages, which compresses e5 query↔passage
 * cosines (measured 2026-07-10 with e5-small on the golden fixture: true sk→en
 * matches land at 0.79–0.81, under the 0.82 message gate, while ranking stays
 * perfect). The gate only strains noise; RRF does the ranking above it.
 */
export const DEFAULT_SUMMARY_MIN_COSINE = 0.78;

function readMinCosine(db: DatabaseSync, key: string, fallback: number): number {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined;
    const v = Number.parseFloat(row?.value ?? '');
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** The tunable message min-cosine from the meta table, or the default when unset/unreadable. */
export function readSemanticMinCosine(db: DatabaseSync): number {
  return readMinCosine(db, 'recall_semantic_min_cosine', DEFAULT_SEMANTIC_MIN_COSINE);
}

/** The tunable summary min-cosine (own key — see DEFAULT_SUMMARY_MIN_COSINE). */
export function readSummaryMinCosine(db: DatabaseSync): number {
  return readMinCosine(db, 'recall_summary_min_cosine', DEFAULT_SUMMARY_MIN_COSINE);
}

/** The row buffer may be reused/unaligned — copy into a fresh, 0-aligned buffer. */
export function bytesToFloat32(u8: Uint8Array): Float32Array {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/**
 * Fuse two ranked lists by reciprocal rank fusion. Returns fused hits, best
 * first, ties broken by `tiebreak` (higher wins). The first list's hit object
 * wins on id collisions (it usually carries the richer snippet); the second
 * leg's evidence fields are grafted on via `graft`.
 */
function rrfFuse<T extends { id: number }>(
  lists: T[][],
  limit: number,
  tiebreak: (hit: T) => number,
  graft: (prior: T, other: T) => void
): Array<T & { score: number }> {
  const merged = new Map<number, T>();
  const rrf = new Map<number, number>();
  for (const list of lists) {
    list.forEach((hit, i) => {
      rrf.set(hit.id, (rrf.get(hit.id) ?? 0) + 1 / (RRF_K + i + 1));
      const prior = merged.get(hit.id);
      if (!prior) merged.set(hit.id, hit);
      else graft(prior, hit);
    });
  }
  return [...merged.values()]
    .map((hit) => ({ ...hit, score: rrf.get(hit.id) ?? 0 }))
    .sort((a, b) => b.score - a.score || tiebreak(b) - tiebreak(a))
    .slice(0, limit);
}

// ---- episodic messages ----

export interface MessageSearchOptions {
  limit?: number;
  /** Exclude hits from this thread (the current chat — its history is already in context). */
  excludeThreadId?: string | null;
  /** Max characters of a semantic hit's excerpt (FTS hits use the FTS snippet). */
  snippetChars?: number;
}

/**
 * bm25-gated FTS leg over captured messages. [] on no match, malformed index, or
 * a pre-v2 DB — retrieval must never throw across a turn or a tool call.
 */
export function ftsSearchMessages(
  db: DatabaseSync,
  rawQuery: string,
  opts: MessageSearchOptions = {}
): CoreSearchHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  const limit = opts.limit ?? FTS_CANDIDATES;
  const exclude = opts.excludeThreadId ?? null;
  try {
    const rows = db
      .prepare(
        `SELECT m.id AS id, m.thread_id AS threadId, m.turn_id AS turnId, m.role AS role,
                m.ts AS ts, m.text AS text,
                snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet,
                bm25(messages_fts) AS score
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ?
           AND (? IS NULL OR m.thread_id <> ?)
         ORDER BY score
         LIMIT ?`
      )
      .all(match, exclude, exclude, limit) as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        id: r.id as number,
        threadId: r.threadId as string,
        turnId: (r.turnId as string | null) ?? null,
        role: r.role as CoreRole,
        ts: r.ts as number,
        text: r.text as string,
        snippet: r.snippet as string,
        score: r.score as number
      }))
      .filter((h) => h.score <= FTS_SCORE_CEILING);
  } catch {
    return [];
  }
}

/**
 * Brute-force cosine top-N over the cached message vectors for `model`. Streams
 * rows instead of materializing a full id→vector map — the message set can reach
 * tens of thousands of rows, and a per-turn multi-MB allocation is the thing to
 * avoid; the arithmetic itself is cheap. Chunk vectors are preferred; the v1
 * lead-vector table covers messages without chunks. Rows with a dim mismatch
 * (stale model collision) are skipped. [] on any failure (e.g. old DB without
 * the tables).
 */
export function semanticSearchMessagesCore(
  db: DatabaseSync,
  qVec: Float32Array,
  model: string,
  opts: { limit: number; minCosine: number; excludeThreadId?: string | null; snippetChars?: number }
): CoreSearchHit[] {
  if (opts.limit <= 0) return [];
  const exclude = opts.excludeThreadId ?? null;
  const snippetChars = opts.snippetChars ?? 400;
  const qMag = Math.sqrt(qVec.reduce((s, v) => s + v * v, 0));
  if (qMag === 0) return [];
  try {
    const hasChunks = (db.prepare(
      `SELECT EXISTS(SELECT 1 FROM message_chunk_vectors WHERE model = ?) AS n`
    ).get(model) as { n: number }).n === 1;
    const stmt = hasChunks
      ? db.prepare(
        `SELECT v.message_id AS id, v.vec AS vec, m.thread_id AS threadId, m.turn_id AS turnId,
                m.role AS role, m.ts AS ts, m.text AS fullText, c.text AS text,
                c.end_offset AS endOffset, LENGTH(m.text) AS fullLength
         FROM message_chunk_vectors v
         JOIN message_chunks c ON c.message_id = v.message_id AND c.chunk_index = v.chunk_index
         JOIN messages m ON m.id = v.message_id
         WHERE v.model = ? AND (? IS NULL OR m.thread_id <> ?)
         UNION ALL
         SELECT v.message_id AS id, v.vec AS vec, m.thread_id AS threadId, m.turn_id AS turnId,
                m.role AS role, m.ts AS ts, m.text AS fullText, m.text AS text,
                LENGTH(m.text) AS endOffset, LENGTH(m.text) AS fullLength
         FROM message_vectors v JOIN messages m ON m.id = v.message_id
         WHERE v.model = ? AND NOT EXISTS (
           SELECT 1 FROM message_chunk_vectors cv WHERE cv.message_id = v.message_id AND cv.model = ?
         ) AND (? IS NULL OR m.thread_id <> ?)`
      )
      : db.prepare(
        `SELECT v.message_id AS id, v.vec AS vec, m.thread_id AS threadId, m.turn_id AS turnId,
                m.role AS role, m.ts AS ts, m.text AS fullText, m.text AS text,
                LENGTH(m.text) AS endOffset, LENGTH(m.text) AS fullLength
         FROM message_vectors v JOIN messages m ON m.id = v.message_id
         WHERE v.model = ? AND (? IS NULL OR m.thread_id <> ?)`
      );
    const params = hasChunks
      ? [model, exclude, exclude, model, model, exclude, exclude]
      : [model, exclude, exclude];
    const top: CoreSearchHit[] = [];
    for (const row of stmt.iterate(...params) as Iterable<Record<string, unknown>>) {
      const vec = bytesToFloat32(row.vec as Uint8Array);
      if (vec.length !== qVec.length) continue;
      let dot = 0;
      let mag = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += vec[i] * qVec[i];
        mag += vec[i] * vec[i];
      }
      const denom = qMag * Math.sqrt(mag);
      const cos = denom === 0 ? 0 : dot / denom;
      if (cos < opts.minCosine) continue;
      const text = row.text as string;
      const excerpt = text.length <= snippetChars
        ? text
        : (row.endOffset as number) >= (row.fullLength as number)
          ? `…${text.slice(-(snippetChars - 1))}`
          : `${text.slice(0, snippetChars - 1)}…`;
      const hit: CoreSearchHit = {
        id: row.id as number,
        threadId: row.threadId as string,
        turnId: (row.turnId as string | null) ?? null,
        role: row.role as CoreRole,
        ts: row.ts as number,
        text: row.fullText as string,
        snippet: excerpt,
        score: cos,
        cosine: cos
      };
      insertTopN(top, hit, cos, opts.limit);
    }
    return top;
  } catch {
    return [];
  }
}

/** Insertion into a small sorted top-N, deduped by id (limit is single digits in practice). */
function insertTopN<T extends { id: number; cosine?: number }>(
  top: T[],
  hit: T,
  cos: number,
  limit: number
): void {
  const prior = top.findIndex((t) => t.id === hit.id);
  if (prior !== -1) {
    if ((top[prior].cosine ?? 0) >= cos) return;
    top.splice(prior, 1);
  }
  const at = top.findIndex((t) => cos > (t.cosine ?? 0));
  if (at === -1) {
    if (top.length < limit) top.push(hit);
  } else {
    top.splice(at, 0, hit);
    if (top.length > limit) top.pop();
  }
}

/** True when ANY message vector is cached (any model) — the pre-embed gate. */
export function hasMessageVectorsCore(db: DatabaseSync): boolean {
  try {
    const row = db.prepare(
      `SELECT (EXISTS(SELECT 1 FROM message_chunk_vectors) OR EXISTS(SELECT 1 FROM message_vectors)) AS n`
    ).get() as { n: number };
    return row.n === 1;
  } catch {
    return false;
  }
}

/** Resolved options for one cosine-leg scan (minCosine already read from meta). */
export interface SemanticScanOptions {
  limit: number;
  minCosine: number;
  excludeThreadId: string | null;
  snippetChars?: number;
}

export interface HybridMessageOptions extends MessageSearchOptions {
  embedQuery?: EmbedQueryFn;
  /**
   * Override for the cosine leg — e.g. run the O(N) scan in a worker process
   * instead of on the caller's event loop. Defaults to the in-process scan.
   * A throw degrades to FTS-only, same as a failed embed.
   */
  semanticScan?: (qe: QueryEmbedding, opts: SemanticScanOptions) => Promise<CoreSearchHit[]>;
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
export async function hybridSearchMessages(
  db: DatabaseSync,
  rawQuery: string,
  opts: HybridMessageOptions = {}
): Promise<CoreSearchHit[]> {
  const limit = opts.limit ?? 5;
  const fts = ftsSearchMessages(db, rawQuery, {
    limit: FTS_CANDIDATES,
    excludeThreadId: opts.excludeThreadId
  });

  let sem: CoreSearchHit[] = [];
  if (opts.embedQuery && hasMessageVectorsCore(db)) {
    const semStart = Date.now();
    try {
      const qe = await opts.embedQuery();
      if (qe) {
        const scanOpts: SemanticScanOptions = {
          limit: SEMANTIC_CANDIDATES,
          minCosine: readSemanticMinCosine(db),
          excludeThreadId: opts.excludeThreadId ?? null,
          snippetChars: opts.snippetChars
        };
        sem = opts.semanticScan
          ? await opts.semanticScan(qe, scanOpts)
          : semanticSearchMessagesCore(db, qe.vec, qe.model, scanOpts);
      }
    } catch {
      // The semantic leg is optional; a dead embedder must never break a turn.
    }
    if (opts.timingSink) opts.timingSink.semantic = Date.now() - semStart;
  }
  if (sem.length === 0) return fts.slice(0, limit);

  // First sighting wins (FTS hits carry the real snippet); the other leg's
  // evidence is grafted onto it.
  return rrfFuse(
    [fts.map((h) => ({ ...h, ftsScore: h.score })), sem],
    limit,
    (h) => h.ts,
    (prior, other) => {
      prior.cosine = prior.cosine ?? other.cosine;
    }
  );
}

// ---- durable facts ----

/**
 * bm25-gated FTS leg over active facts. Unlike the main process's lexical fact
 * tier (rankFactsLexically: recency-blended, trigram-backed), this is the plain
 * hybrid leg used by the MCP search_facts tool.
 */
export function ftsSearchFacts(db: DatabaseSync, rawQuery: string, limit = FTS_CANDIDATES): CoreFactHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  try {
    const rows = db
      .prepare(
        `SELECT f.id AS id, f.text AS text, bm25(facts_fts) AS score
         FROM facts_fts
         JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ? AND f.status = 'active'
         ORDER BY score
         LIMIT ?`
      )
      .all(match, limit) as Array<{ id: number; text: string; score: number }>;
    return rows.filter((r) => r.score <= FTS_SCORE_CEILING);
  } catch {
    return [];
  }
}

/**
 * Cosine top-N over fact_vectors. No min-cosine floor: facts are short and few,
 * so RRF sorts out weak hits. [] on any failure (e.g. old DB without the table).
 */
export function semanticSearchFactsCore(
  db: DatabaseSync,
  qVec: Float32Array,
  model: string,
  limit: number
): CoreFactHit[] {
  const qMag = Math.sqrt(qVec.reduce((s, v) => s + v * v, 0));
  if (qMag === 0 || limit <= 0) return [];
  try {
    const scored: CoreFactHit[] = [];
    const rows = db
      .prepare(
        `SELECT v.fact_id AS id, v.vec AS vec, f.text AS text
         FROM fact_vectors v JOIN facts f ON f.id = v.fact_id
         WHERE v.model = ? AND f.status = 'active'`
      )
      .iterate(model) as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const vec = bytesToFloat32(row.vec as Uint8Array);
      if (vec.length !== qVec.length) continue;
      let dot = 0;
      let mag = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += vec[i] * qVec[i];
        mag += vec[i] * vec[i];
      }
      const denom = qMag * Math.sqrt(mag);
      scored.push({ id: row.id as number, text: row.text as string, score: denom === 0 ? 0 : dot / denom });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  } catch {
    return [];
  }
}

/** Hybrid facts search: FTS leg + semantic leg fused by RRF; FTS-only when semantic fails. */
export async function hybridSearchFacts(
  db: DatabaseSync,
  rawQuery: string,
  opts: { limit?: number; embedQuery?: EmbedQueryFn } = {}
): Promise<CoreFactHit[]> {
  const limit = opts.limit ?? 10;
  const fts = ftsSearchFacts(db, rawQuery, FTS_CANDIDATES);
  let sem: CoreFactHit[] = [];
  if (opts.embedQuery) {
    try {
      const qe = await opts.embedQuery();
      if (qe) sem = semanticSearchFactsCore(db, qe.vec, qe.model, SEMANTIC_CANDIDATES);
    } catch {
      // Semantic leg optional.
    }
  }
  if (sem.length === 0) return fts.slice(0, limit);
  return rrfFuse([fts, sem], limit, () => 0, () => {});
}

// ---- thread summaries (Level 1.5) ----

export interface SummarySearchOptions {
  limit?: number;
  excludeThreadId?: string | null;
  embedQuery?: EmbedQueryFn;
  /** Same contract as HybridMessageOptions.semanticScan, for the summary leg. */
  semanticScan?: (qe: QueryEmbedding, opts: SemanticScanOptions) => Promise<CoreSummaryHit[]>;
}

/** bm25-gated FTS leg over thread summaries. [] on a pre-v3 DB without the table. */
export function ftsSearchSummaries(
  db: DatabaseSync,
  rawQuery: string,
  opts: { limit?: number; excludeThreadId?: string | null } = {}
): CoreSummaryHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  const limit = opts.limit ?? FTS_CANDIDATES;
  const exclude = opts.excludeThreadId ?? null;
  try {
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.thread_id AS threadId, s.text AS text,
                s.first_ts AS firstTs, s.last_ts AS lastTs,
                bm25(summaries_fts) AS score
         FROM summaries_fts
         JOIN summaries s ON s.id = summaries_fts.rowid
         WHERE summaries_fts MATCH ?
           AND (? IS NULL OR s.thread_id <> ?)
         ORDER BY score
         LIMIT ?`
      )
      .all(match, exclude, exclude, limit) as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        id: r.id as number,
        threadId: r.threadId as string,
        text: r.text as string,
        firstTs: r.firstTs as number,
        lastTs: r.lastTs as number,
        score: r.score as number
      }))
      .filter((h) => h.score <= FTS_SCORE_CEILING);
  } catch {
    return [];
  }
}

/**
 * Cosine top-N over summary_vectors, gated by the summary-specific min-cosine
 * (see DEFAULT_SUMMARY_MIN_COSINE — long passages score lower than messages).
 * [] on any failure, including a pre-v3 DB.
 */
export function semanticSearchSummariesCore(
  db: DatabaseSync,
  qVec: Float32Array,
  model: string,
  opts: { limit: number; minCosine: number; excludeThreadId?: string | null }
): CoreSummaryHit[] {
  if (opts.limit <= 0) return [];
  const exclude = opts.excludeThreadId ?? null;
  const qMag = Math.sqrt(qVec.reduce((s, v) => s + v * v, 0));
  if (qMag === 0) return [];
  try {
    const scored: CoreSummaryHit[] = [];
    const rows = db
      .prepare(
        `SELECT v.summary_id AS id, v.vec AS vec, s.thread_id AS threadId, s.text AS text,
                s.first_ts AS firstTs, s.last_ts AS lastTs
         FROM summary_vectors v JOIN summaries s ON s.id = v.summary_id
         WHERE v.model = ? AND (? IS NULL OR s.thread_id <> ?)`
      )
      .iterate(model, exclude, exclude) as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const vec = bytesToFloat32(row.vec as Uint8Array);
      if (vec.length !== qVec.length) continue;
      let dot = 0;
      let mag = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += vec[i] * qVec[i];
        mag += vec[i] * vec[i];
      }
      const denom = qMag * Math.sqrt(mag);
      const cos = denom === 0 ? 0 : dot / denom;
      if (cos < opts.minCosine) continue;
      scored.push({
        id: row.id as number,
        threadId: row.threadId as string,
        text: row.text as string,
        firstTs: row.firstTs as number,
        lastTs: row.lastTs as number,
        score: cos,
        cosine: cos
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit);
  } catch {
    return [];
  }
}

/**
 * Hybrid summary search: FTS + cosine legs fused by RRF, same shape as episodic
 * messages. Degrades to FTS-only without embeddings, and to [] on a pre-v3 DB.
 */
export async function hybridSearchSummaries(
  db: DatabaseSync,
  rawQuery: string,
  opts: SummarySearchOptions = {}
): Promise<CoreSummaryHit[]> {
  const limit = opts.limit ?? 3;
  const fts = ftsSearchSummaries(db, rawQuery, {
    limit: FTS_CANDIDATES,
    excludeThreadId: opts.excludeThreadId
  });
  let sem: CoreSummaryHit[] = [];
  if (opts.embedQuery) {
    try {
      const qe = await opts.embedQuery();
      if (qe) {
        const scanOpts: SemanticScanOptions = {
          limit: SEMANTIC_CANDIDATES,
          minCosine: readSummaryMinCosine(db),
          excludeThreadId: opts.excludeThreadId ?? null
        };
        sem = opts.semanticScan
          ? await opts.semanticScan(qe, scanOpts)
          : semanticSearchSummariesCore(db, qe.vec, qe.model, scanOpts);
      }
    } catch {
      // Semantic leg optional.
    }
  }
  if (sem.length === 0) return fts.slice(0, limit);
  return rrfFuse(
    [fts.map((h) => ({ ...h, ftsScore: h.score })), sem],
    limit,
    (h) => h.lastTs,
    (prior, other) => {
      prior.cosine = prior.cosine ?? other.cosine;
    }
  );
}
