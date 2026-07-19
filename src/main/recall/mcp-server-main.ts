// Stem Recall — standalone stdio MCP server exposing `search_past_chats`
// (episodic messages), `search_facts` (durable Level-1 facts) and
// `search_chat_summaries` (Level-1.5 rolling thread summaries).
//
// The pi backend spawns this as an MCP server (registered in mcp.json by
// pi/mcp-config.ts). It runs under Electron-as-node (ELECTRON_RUN_AS_NODE=1) so
// it shares the exact node:sqlite runtime as the main process. It opens
// recall.sqlite READ-ONLY at the path given in STEM_RECALL_DB.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one message per line).
//
// Search is HYBRID: the FTS legs run locally against recall.sqlite; the semantic
// legs embed the query through main's unix-socket embed endpoint (STEM_EMBED_SOCK
// + STEM_EMBED_TOKEN, see embed-endpoint.ts) and cosine-rank the cached vectors,
// fused by reciprocal rank fusion. ANY semantic failure (main not running,
// socket gone, embeddings off, old DB without the tables) degrades to FTS-only.
//
// All retrieval mechanics are imported from search-core.ts — the SAME module the
// main process uses — so the two processes cannot drift. This file owns only the
// JSON-RPC plumbing, the socket embed client, tool descriptors and formatting.
// It is bundled to dist/main/recall-mcp-server.js (see electron.vite.config.ts)
// and must never import 'electron'.

import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import {
  hybridSearchFacts,
  hybridSearchMessages,
  hybridSearchSummaries,
  type CoreFactHit,
  type CoreSearchHit,
  type CoreSummaryHit,
  type QueryEmbedding
} from './search-core';

const DB_PATH = process.env.STEM_RECALL_DB;
const EMBED_SOCK = process.env.STEM_EMBED_SOCK;
const EMBED_TOKEN = process.env.STEM_EMBED_TOKEN;

let db: DatabaseSync | null = null;
function open(): DatabaseSync {
  if (db) return db;
  if (!DB_PATH) throw new Error('STEM_RECALL_DB is not set');
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  // A scan-worker VACUUM briefly locks even readers out — wait, don't throw.
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/**
 * Embed the query through main's unix-socket endpoint. Returns
 * {vec, model} or null on ANY failure — no retries, the next tool call retries
 * naturally. Deadlines: 2.5 s overall (a slow first embed can take >1 s).
 */
function embedQueryViaSocket(query: string): Promise<QueryEmbedding | null> {
  if (!EMBED_SOCK || !EMBED_TOKEN) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: QueryEmbedding | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(v);
    };
    const deadline = setTimeout(() => done(null), 2500);
    const socket = connect(EMBED_SOCK);
    socket.setTimeout(2500, () => done(null));
    socket.on('error', () => done(null));
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        const res = JSON.parse(buf.slice(0, nl)) as {
          ok?: boolean;
          vectors?: number[][];
          model?: string;
        };
        if (res?.ok && Array.isArray(res.vectors) && (res.vectors[0]?.length ?? 0) > 0 && typeof res.model === 'string') {
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

/** One-shot embed thunk for a single tool call (each call embeds at most once). */
function embedOnce(query: string): () => Promise<QueryEmbedding | null> {
  let memo: Promise<QueryEmbedding | null> | null = null;
  return () => (memo ??= embedQueryViaSocket(query));
}

function clampLimit(limit: unknown, fallback: number, max: number): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? limit : fallback;
  return Math.max(1, Math.min(n, max));
}

async function searchPastChats(query: string, limit: unknown): Promise<CoreSearchHit[]> {
  return hybridSearchMessages(open(), query, {
    limit: clampLimit(limit, 8, 20),
    snippetChars: 600,
    embedQuery: embedOnce(query)
  });
}

async function searchFacts(query: string, limit: unknown): Promise<CoreFactHit[]> {
  return hybridSearchFacts(open(), query, {
    limit: clampLimit(limit, 10, 30),
    embedQuery: embedOnce(query)
  });
}

async function searchSummaries(query: string, limit: unknown): Promise<CoreSummaryHit[]> {
  return hybridSearchSummaries(open(), query, {
    limit: clampLimit(limit, 5, 12),
    embedQuery: embedOnce(query)
  });
}

function formatFacts(rows: CoreFactHit[]): string {
  if (rows.length === 0) return 'No matching stored facts found.';
  return rows.map((r) => `- ${r.text.replace(/\s+/g, ' ').trim()}`).join('\n');
}

function isoDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function formatResults(rows: CoreSearchHit[]): string {
  if (rows.length === 0) return 'No matching past conversations found.';
  return rows
    .map((r) => {
      const who = r.role === 'user' ? 'User' : 'Assistant';
      // The full message text, not the «»-marked FTS snippet — tool output
      // stays clean of highlight markers (matches the pre-core behavior).
      const text = r.text.replace(/\s+/g, ' ').trim().slice(0, 600);
      return `[${isoDate(r.ts)}] ${who}${r.role === 'assistant' ? ' claim (untrusted until confirmed)' : ''}: ${text}`;
    })
    .join('\n\n');
}

function formatSummaries(rows: CoreSummaryHit[]): string {
  if (rows.length === 0) {
    return 'No matching conversation summaries found (summaries build as the user chats — try search_past_chats for verbatim messages).';
  }
  return rows
    .map((r) => {
      const range = r.firstTs === r.lastTs || isoDate(r.firstTs) === isoDate(r.lastTs)
        ? isoDate(r.lastTs)
        : `${isoDate(r.firstTs)} → ${isoDate(r.lastTs)}`;
      const text = r.text.replace(/\s+/g, ' ').trim();
      return `[${range}] (thread ${r.threadId}) ${text}`;
    })
    .join('\n\n');
}

// ---- minimal MCP / JSON-RPC plumbing ----

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: { query?: unknown; limit?: unknown };
  };
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: number | string | undefined, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: number | string | undefined, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const FACTS_TOOL = {
  name: 'search_facts',
  description:
    'Search the durable facts Stem has learned about the user (family, vehicles, home, health, preferences, plans). Only the facts most relevant to the current message are pre-injected, so when a request depends on personal context that might not be in view — planning, purchases, recommendations, anything where family members, ages, vehicle, budget or preferences would change the answer — search here first. Matching is keyword plus semantic (multilingual); if a search misses, retry with the key terms in the other language (e.g. add English to a Slovak query).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for — a topic or attribute, e.g. "family children age", "car vehicle", "rodina deti".' },
      limit: { type: 'number', description: 'Max facts to return (default 10, max 30).' }
    },
    required: ['query']
  }
};

const CHATS_TOOL = {
  name: 'search_past_chats',
  description:
    'Search the user\'s past conversations (across all chats) for anything previously said or shown — facts, decisions, details fetched from email/web, prior questions. Use when the user refers to something not in the current chat, or to recall context about them. Returns dated verbatim snippets; for a thread-level overview of what a past conversation covered and decided, search_chat_summaries is usually the better first stop. Matching is hybrid: keyword plus semantic (multilingual) while the Stem app is running, keyword-only otherwise. Semantic matching usually bridges Slovak/English/German, but it is imperfect — when a search misses, retry with key synonyms in the OTHER language (e.g. add English terms to a Slovak query), which also covers the keyword-only fallback.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for — a phrase or keywords. Semantic matching usually bridges Slovak/English/German; if a search misses, retry with the key terms translated into the other language (e.g. "zdravotný stav health diagnosis").' },
      limit: { type: 'number', description: 'Max snippets to return (default 8, max 20).' }
    },
    required: ['query']
  }
};

const SUMMARIES_TOOL = {
  name: 'search_chat_summaries',
  description:
    'Search rolling English summaries of the user\'s past conversation threads — what each chat was about, what was decided, and what stayed open. Use for thread-level questions ("what did we conclude about X?", "which chat discussed Y?") before drilling into verbatim messages with search_past_chats. Summaries are in English regardless of the conversation language, so English query terms work best; matching is keyword plus semantic (multilingual).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Topic, decision or entity to look for, e.g. "kitchen renovation budget decision".' },
      limit: { type: 'number', description: 'Max summaries to return (default 5, max 12).' }
    },
    required: ['query']
  }
};

function handle(msg: RpcMessage): void {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stem-recall', version: '0.2.0' }
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return; // notification, no reply
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: [CHATS_TOOL, FACTS_TOOL, SUMMARIES_TOOL] });
      return;
    case 'tools/call': {
      const name = params?.name;
      if (name !== 'search_past_chats' && name !== 'search_facts' && name !== 'search_chat_summaries') {
        replyError(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      void (async () => {
        try {
          const query = String(params?.arguments?.query ?? '');
          const limit = params?.arguments?.limit;
          const text =
            name === 'search_facts'
              ? formatFacts(await searchFacts(query, limit))
              : name === 'search_chat_summaries'
                ? formatSummaries(await searchSummaries(query, limit))
                : formatResults(await searchPastChats(query, limit));
          reply(id, { content: [{ type: 'text', text }] });
        } catch (e) {
          // Surface as a tool error rather than crashing the server.
          reply(id, {
            content: [{ type: 'text', text: `Recall search failed: ${(e as Error).message}` }],
            isError: true
          });
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
  let msg: RpcMessage;
  try {
    msg = JSON.parse(trimmed) as RpcMessage;
  } catch {
    return;
  }
  try {
    handle(msg);
  } catch (e) {
    if (msg?.id !== undefined) replyError(msg.id, -32603, (e as Error).message);
  }
});
