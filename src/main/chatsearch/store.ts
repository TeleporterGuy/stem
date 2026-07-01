import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chatSearchDbPath } from '../workspace/paths';

// Chat Search's storage layer. Owns chat_search.sqlite end-to-end. It mirrors the
// proven recall/store.ts idioms (node:sqlite, WAL, an FTS5 index kept in lockstep
// with a content table via triggers, unicode61 tokenizer so Slovak/German/English
// all tokenize) — but it is a SEPARATE database on purpose:
//
//   Recall's messages_fts is governed by privacy rules (memorize:false contexts and
//   read-only connected folders are excluded/tainted, and it only holds what was
//   captured since recall started). "Search my own chats" must obey none of that —
//   you should find a chat even if it was marked don't-remember. So we index the
//   JSONL sessions directly into our own store, decoupled from recall.
//
// node:sqlite is synchronous, so no async write-queue is needed. Ops here are tiny.

export interface ChatDocHit {
  threadId: string;
  role: string;
  ts: number;
  snippet: string;
  /** bm25 score (lower = better match). */
  score: number;
}

/** A message to index. Title is indexed separately (see reindexThread). */
export interface IndexDoc {
  role: string;
  text: string;
  /** Unix seconds. */
  ts: number;
}

let db: DatabaseSync | null = null;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function dedupKey(threadId: string, ord: number, text: string): string {
  return createHash('sha256').update(`${threadId}|${ord}|${text}`).digest('hex').slice(0, 32);
}

function open(): DatabaseSync {
  if (db) return db;
  const handle = new DatabaseSync(chatSearchDbPath());
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS chat_docs (
      id        INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ord       INTEGER NOT NULL,
      role      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      text      TEXT NOT NULL,
      dedup_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_docs_thread ON chat_docs(thread_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS chat_docs_fts USING fts5(
      text,
      content='chat_docs',
      content_rowid='id',
      tokenize='unicode61'
    );

    -- Keep the FTS index in lockstep with chat_docs (append/delete only — reindex is
    -- delete-then-insert, so no UPDATE trigger is needed).
    CREATE TRIGGER IF NOT EXISTS chat_docs_ai AFTER INSERT ON chat_docs BEGIN
      INSERT INTO chat_docs_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_docs_ad AFTER DELETE ON chat_docs BEGIN
      INSERT INTO chat_docs_fts(chat_docs_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;

    -- Per-thread watermark: the file updatedAt we last indexed this thread at. Backfill
    -- skips any thread whose on-disk updatedAt is not newer, so relaunches are cheap and
    -- externally-edited sessions are caught.
    CREATE TABLE IF NOT EXISTS chat_index_state (
      thread_id          TEXT PRIMARY KEY,
      indexed_updated_at INTEGER NOT NULL
    );
  `);
  db = handle;
  return handle;
}

/** The updatedAt (Unix seconds) this thread was last indexed at, or null if never. */
export function getIndexedWatermark(threadId: string): number | null {
  const handle = open();
  const row = handle
    .prepare(`SELECT indexed_updated_at AS wm FROM chat_index_state WHERE thread_id = ?`)
    .get(threadId) as { wm: number } | undefined;
  return row ? row.wm : null;
}

/**
 * Replace a thread's indexed docs with `title` (ord 0) + `docs` (ord 1..n) and bump
 * its watermark — all in one transaction so a reader never sees a half-indexed thread.
 * Blank docs are skipped; a thread with no searchable text still records its title so
 * title matches work and its watermark advances (so backfill won't retry it forever).
 */
export function reindexThread(threadId: string, title: string, docs: IndexDoc[], updatedAt: number): void {
  const handle = open();
  const del = handle.prepare(`DELETE FROM chat_docs WHERE thread_id = ?`);
  const ins = handle.prepare(
    `INSERT OR IGNORE INTO chat_docs (thread_id, ord, role, ts, text, dedup_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const mark = handle.prepare(
    `INSERT INTO chat_index_state (thread_id, indexed_updated_at) VALUES (?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET indexed_updated_at = excluded.indexed_updated_at`
  );
  handle.exec('BEGIN');
  try {
    del.run(threadId);
    let ord = 0;
    const now = nowSeconds();
    const titleText = title.trim();
    if (titleText) ins.run(threadId, ord++, 'title', now, titleText, dedupKey(threadId, 0, titleText));
    for (const d of docs) {
      const text = d.text.trim();
      if (!text) continue;
      ins.run(threadId, ord, d.role, d.ts, text, dedupKey(threadId, ord, text));
      ord++;
    }
    mark.run(threadId, updatedAt);
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/** Drop a thread from the index entirely (on chat delete). */
export function dropThread(threadId: string): void {
  const handle = open();
  handle.exec('BEGIN');
  try {
    handle.prepare(`DELETE FROM chat_docs WHERE thread_id = ?`).run(threadId);
    handle.prepare(`DELETE FROM chat_index_state WHERE thread_id = ?`).run(threadId);
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Search all indexed chat docs. `query` must already be a valid FTS5 MATCH expression
 * (build one safely from raw user text via search.ts / recall's buildMatchQuery). Rows
 * come back best-first; callers group by thread_id (the first row per thread is its
 * best-matching doc). `limit` bounds the row scan, not the thread count.
 */
export function searchChatDocs(query: string, limit = 200): ChatDocHit[] {
  if (!query.trim()) return [];
  const handle = open();
  const rows = handle
    .prepare(
      `SELECT d.thread_id AS threadId, d.role AS role, d.ts AS ts,
              snippet(chat_docs_fts, 0, '«', '»', '…', 12) AS snippet,
              bm25(chat_docs_fts) AS score
       FROM chat_docs_fts
       JOIN chat_docs d ON d.id = chat_docs_fts.rowid
       WHERE chat_docs_fts MATCH ?
       ORDER BY score
       LIMIT ?`
    )
    .all(query, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    threadId: r.threadId as string,
    role: r.role as string,
    ts: r.ts as number,
    snippet: r.snippet as string,
    score: r.score as number
  }));
}
