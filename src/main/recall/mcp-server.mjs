// Stem Recall — standalone stdio MCP server exposing `search_past_chats`.
//
// The pi backend spawns this as an MCP server (registered in mcp.json by
// pi/mcp-config.ts). It runs under Electron-as-node (ELECTRON_RUN_AS_NODE=1) so it
// shares the exact node:sqlite runtime as the main process. It opens recall.sqlite
// READ-ONLY at the path given in STEM_RECALL_DB.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one message per line).
//
// Search is HYBRID: the FTS leg runs locally against recall.sqlite; the semantic
// leg embeds the query through main's unix-socket embed endpoint (STEM_EMBED_SOCK
// + STEM_EMBED_TOKEN, see embed-endpoint.ts) and cosine-ranks the message_vectors
// table, fused by reciprocal rank fusion. ANY semantic failure (main not running,
// socket gone, embeddings off, old DB without the table) degrades to FTS-only.
//
// Hand-copied from src/main/recall/{store,search}.ts — keep in sync (a separate
// process can't import the TS modules): STOPWORDS + buildMatchQuery (search.ts),
// RRF_K / candidate sizes / FTS_SCORE_CEILING (search.ts), bytesToFloat32
// (store.ts), the semantic min-cosine default (store.ts), the socket protocol
// (embed-endpoint.ts).

import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';

const DB_PATH = process.env.STEM_RECALL_DB;
const EMBED_SOCK = process.env.STEM_EMBED_SOCK;
const EMBED_TOKEN = process.env.STEM_EMBED_TOKEN;

const RRF_K = 60;
const FTS_CANDIDATES = 12;
const SEMANTIC_CANDIDATES = 12;
const FTS_SCORE_CEILING = -0.1;
const DEFAULT_SEMANTIC_MIN_COSINE = 0.82;

let db = null;
function open() {
  if (db) return db;
  if (!DB_PATH) throw new Error('STEM_RECALL_DB is not set');
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  return db;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'for',
  'with', 'that', 'this', 'it', 'i', 'you', 'we', 'my', 'me', 'do', 'does', 'did', 'what', 'who',
  'when', 'where', 'why', 'how', 'about',
  'aby', 'ako', 'ale', 'som', 'si', 'sa', 'na', 'je', 'co', 'čo', 'ktorý', 'kde',
  'der', 'die', 'das', 'und', 'ich', 'ist', 'für', 'mit', 'wie'
]);

function buildMatchQuery(raw) {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length >= 2 && !STOPWORDS.has(t)
  );
  const seen = new Set();
  const terms = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    terms.push(`"${t.replace(/"/g, '""')}"`);
  }
  return terms.length ? terms.join(' OR ') : null;
}

function ftsSearch(query, limit) {
  const match = buildMatchQuery(query);
  if (!match) return [];
  const handle = open();
  return handle
    .prepare(
      `SELECT m.id AS id, m.thread_id AS threadId, m.role AS role, m.ts AS ts, m.text AS text,
              bm25(messages_fts) AS score
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY score
       LIMIT ?`
    )
    .all(match, limit)
    .filter((r) => r.score <= FTS_SCORE_CEILING);
}

/**
 * Embed the query through main's unix-socket endpoint. Returns
 * {vec: Float32Array, model} or null on ANY failure — no retries, the next tool
 * call retries naturally. Deadlines: 1 s to connect, 2.5 s overall.
 */
function embedQueryViaSocket(query) {
  if (!EMBED_SOCK || !EMBED_TOKEN) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(v);
    };
    const deadline = setTimeout(() => done(null), 2500);
    const socket = connect(EMBED_SOCK);
    socket.setTimeout(2500, () => done(null)); // idle timeout (a slow first embed can take >1 s)
    socket.on('error', () => done(null));
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        const res = JSON.parse(buf.slice(0, nl));
        if (res?.ok && Array.isArray(res.vectors) && res.vectors[0]?.length > 0 && typeof res.model === 'string') {
          done({ vec: Float32Array.from(res.vectors[0]), model: res.model });
        } else {
          done(null);
        }
      } catch {
        done(null);
      }
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, op: 'embed', kind: 'query', texts: [query], token: EMBED_TOKEN })}\n`);
    });
  });
}

// Mirrors store.ts bytesToFloat32: the row buffer may be unaligned — copy first.
function bytesToFloat32(u8) {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

function semanticMinCosine(handle) {
  try {
    const row = handle.prepare(`SELECT value FROM meta WHERE key = 'recall_semantic_min_cosine'`).get();
    const v = Number.parseFloat(row?.value ?? '');
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_SEMANTIC_MIN_COSINE;
  } catch {
    return DEFAULT_SEMANTIC_MIN_COSINE;
  }
}

/** Cosine top-N over message_vectors. [] on any failure (e.g. pre-B4 DB without the table). */
function semanticSearch(qVec, model, limit) {
  try {
    const handle = open();
    const minCosine = semanticMinCosine(handle);
    let qMag = 0;
    for (const v of qVec) qMag += v * v;
    qMag = Math.sqrt(qMag);
    if (qMag === 0) return [];
    const top = [];
    const rows = handle
      .prepare(
        `SELECT v.message_id AS id, v.vec AS vec, m.thread_id AS threadId, m.role AS role,
                m.ts AS ts, m.text AS text
         FROM message_vectors v JOIN messages m ON m.id = v.message_id
         WHERE v.model = ?`
      )
      .iterate(model);
    for (const row of rows) {
      const vec = bytesToFloat32(row.vec);
      if (vec.length !== qVec.length) continue;
      let dot = 0;
      let mag = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += vec[i] * qVec[i];
        mag += vec[i] * vec[i];
      }
      const denom = qMag * Math.sqrt(mag);
      const cos = denom === 0 ? 0 : dot / denom;
      if (cos < minCosine) continue;
      const hit = { id: row.id, threadId: row.threadId, role: row.role, ts: row.ts, text: row.text, score: cos };
      const at = top.findIndex((t) => cos > t.score);
      if (at === -1) {
        if (top.length < limit) top.push(hit);
      } else {
        top.splice(at, 0, hit);
        if (top.length > limit) top.pop();
      }
    }
    return top;
  } catch {
    return [];
  }
}

/** Hybrid search: FTS leg + semantic leg fused by RRF; FTS-only when semantic fails. */
async function searchPastChats(query, limit) {
  const lim = Math.max(1, Math.min(limit ?? 8, 20));
  const fts = ftsSearch(query, FTS_CANDIDATES);
  let sem = [];
  const qe = await embedQueryViaSocket(query);
  if (qe) sem = semanticSearch(qe.vec, qe.model, SEMANTIC_CANDIDATES);
  if (sem.length === 0) return fts.slice(0, lim);

  const rrf = new Map();
  const byId = new Map();
  for (const list of [fts, sem]) {
    list.forEach((hit, i) => {
      rrf.set(hit.id, (rrf.get(hit.id) ?? 0) + 1 / (RRF_K + i + 1));
      if (!byId.has(hit.id)) byId.set(hit.id, hit);
    });
  }
  return [...byId.values()]
    .sort((a, b) => rrf.get(b.id) - rrf.get(a.id) || b.ts - a.ts)
    .slice(0, lim);
}

function formatResults(rows) {
  if (rows.length === 0) return 'No matching past conversations found.';
  return rows
    .map((r) => {
      const date = new Date(r.ts * 1000).toISOString().slice(0, 10);
      const who = r.role === 'user' ? 'User' : 'Assistant';
      const text = r.text.replace(/\s+/g, ' ').trim().slice(0, 600);
      return `[${date}] ${who}: ${text}`;
    })
    .join('\n\n');
}

// ---- minimal MCP / JSON-RPC plumbing ----

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOL = {
  name: 'search_past_chats',
  description:
    'Search the user\'s past conversations (across all chats) for anything previously said or shown — facts, decisions, details fetched from email/web, prior questions. Use when the user refers to something not in the current chat, or to recall context about them. Returns dated snippets. Matching is hybrid: keyword plus semantic (multilingual) while the Stem app is running, keyword-only otherwise. Semantic matching usually bridges Slovak/English/German, but it is imperfect — when a search misses, retry with key synonyms in the OTHER language (e.g. add English terms to a Slovak query), which also covers the keyword-only fallback.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for — a phrase or keywords. Semantic matching usually bridges Slovak/English/German; if a search misses, retry with the key terms translated into the other language (e.g. "zdravotný stav health diagnosis").' },
      limit: { type: 'number', description: 'Max snippets to return (default 8, max 20).' }
    },
    required: ['query']
  }
};

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stem-recall', version: '0.1.0' }
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return; // notification, no reply
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: [TOOL] });
      return;
    case 'tools/call': {
      if (params?.name !== 'search_past_chats') {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      void (async () => {
        try {
          const rows = await searchPastChats(String(params?.arguments?.query ?? ''), params?.arguments?.limit);
          reply(id, { content: [{ type: 'text', text: formatResults(rows) }] });
        } catch (e) {
          // Surface as a tool error rather than crashing the server.
          reply(id, { content: [{ type: 'text', text: `Recall search failed: ${e.message}` }], isError: true });
        }
      })();
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  try {
    handle(msg);
  } catch (e) {
    if (msg?.id !== undefined) replyError(msg.id, -32603, e.message);
  }
});
