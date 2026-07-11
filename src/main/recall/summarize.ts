import {
  getSummaryByThread,
  getThreadMessagesAfter,
  getThreadsNeedingSummary,
  upsertSummary,
  upsertSummaryVector,
  MAX_SUMMARY_CHARS,
  type StoredMessage
} from './store';
import { getEmbeddingsClient } from './retrieval';
import { isRecallEnabled } from '../workspace/memory';
import type { LlmClient } from './llm';

// Level 1.5: one rolling English summary per thread — what the conversation
// covered, decided and left open — revised whenever the distill debounce finds
// new messages on a thread, plus a low-priority dormant backfill. Summaries are
// the injected episodic unit (see inject.ts); raw messages stay reachable via
// the MCP search_past_chats drill-down.
//
// Each summary keeps its OWN watermark (summaries.last_message_id), independent
// of distill_cursor_v2: a failed summary refresh never blocks fact extraction,
// and vice versa. On any LLM failure the watermark stays unmoved so the next
// pass retries the same window.

/** Per-call transcript budget; larger backlogs finish over several passes. */
export const MAX_SUMMARY_TRANSCRIPT_CHARS = 12_000;
/** A single huge message can't monopolize the window. */
const MAX_CHARS_PER_MESSAGE = 2_000;
/** Noise gate: don't burn an LLM call on a couple of words. */
const MIN_NEW_MESSAGES = 2;
const MIN_NEW_CHARS = 200;

export const SUMMARY_INSTRUCTIONS = `You maintain a rolling summary of ONE conversation thread between a user and an assistant.

You are given the prior summary (possibly empty) and the new messages since it was written. Produce a REVISED, self-contained summary of the whole thread so far.

Rules:
- Write in ENGLISH, regardless of the conversation's language.
- Cover: what was discussed, what was decided or concluded, key entities (people, places, products, amounts), resolved dates, and what remains open.
- Prefer concrete specifics over generalities; drop pleasantries and process chatter.
- Do not invent anything not present in the prior summary or the new messages; when new messages correct earlier information, keep only the corrected version.
- At most ${MAX_SUMMARY_CHARS - 500} characters. Plain prose, no headings or bullets.
- Output ONLY {"summary":"..."} as JSON.`;

/** Extract the revised summary from the model's reply. Null when unusable. */
export function parseSummary(output: string): string | null {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(trimmed.slice(start, end + 1)) as { summary?: unknown };
      if (typeof obj.summary === 'string' && obj.summary.trim().length >= 20) {
        return obj.summary.replace(/\s+/g, ' ').trim();
      }
    } catch {
      // Plain-prose fallback below.
    }
  }
  // Some models reply with the summary as plain prose despite the JSON ask.
  // Accept it when it can't be mistaken for malformed JSON or a refusal.
  if (!trimmed.startsWith('{') && trimmed.length >= 40) {
    return trimmed.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS);
  }
  return null;
}

interface SummaryWindow {
  transcript: string;
  messages: StoredMessage[];
  lastIncludedId: number;
}

/** The bounded next window of a thread's messages past the summary watermark. */
function buildWindow(threadId: string, afterId: number): SummaryWindow | null {
  const source = getThreadMessagesAfter(threadId, afterId);
  if (source.length === 0) return null;
  let transcript = '';
  const included: StoredMessage[] = [];
  for (const message of source) {
    const text = message.text.length > MAX_CHARS_PER_MESSAGE
      ? `${message.text.slice(0, MAX_CHARS_PER_MESSAGE)}…`
      : message.text;
    const line = `[${new Date(message.ts * 1000).toISOString().slice(0, 10)} ${message.role}] ${text}`;
    if (transcript && transcript.length + line.length + 1 > MAX_SUMMARY_TRANSCRIPT_CHARS) break;
    transcript += `${transcript ? '\n' : ''}${line}`;
    included.push(message);
  }
  return included.length > 0
    ? { transcript, messages: included, lastIncludedId: included[included.length - 1].id }
    : null;
}

/** Cache the fresh summary vector so search doesn't wait for a backfill pass. Best-effort. */
async function embedSummary(summaryId: number, text: string): Promise<void> {
  try {
    const emb = getEmbeddingsClient();
    if (!emb || !(await emb.available())) return;
    const model = (await emb.modelId()) ?? '';
    if (!model) return;
    const [vec] = await emb.embed([text], 'passage');
    if (vec) upsertSummaryVector(summaryId, model, vec);
  } catch {
    // Non-fatal — getSummariesMissingVector picks it up later.
  }
}

/**
 * Revise one thread's rolling summary from the messages past its watermark.
 * Returns true when a summary was written. One bounded window per call; a large
 * backlog converges over successive passes. On LLM failure the watermark stays
 * unmoved and the next pass retries.
 */
export async function refreshThreadSummary(threadId: string, llm: LlmClient): Promise<boolean> {
  const prior = getSummaryByThread(threadId);
  const window = buildWindow(threadId, prior?.lastMessageId ?? 0);
  if (!window) return false;
  // Noise gate — but never against a backlog: if the window filled to its cap
  // there is real material regardless of message count.
  const newChars = window.transcript.length;
  if (window.messages.length < MIN_NEW_MESSAGES && newChars < MIN_NEW_CHARS) return false;
  if (newChars < MIN_NEW_CHARS && !prior) return false;

  let text: string | null = null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const reply = await llm.complete(
      `${SUMMARY_INSTRUCTIONS}\n\nToday's date: ${today}.\n\nPrior summary:\n${prior?.text ?? '(none — this is the first summary of this thread)'}\n\nNew messages:\n${window.transcript}`
    );
    text = parseSummary(reply);
  } catch {
    return false; // watermark unmoved — retried on the next distill touch
  }
  if (!text) return false;

  const id = upsertSummary({
    threadId,
    text,
    firstTs: window.messages[0].ts,
    lastTs: window.messages[window.messages.length - 1].ts,
    newMessageCount: window.messages.length,
    lastMessageId: window.lastIncludedId
  });
  if (id != null) await embedSummary(id, text.slice(0, MAX_SUMMARY_CHARS));
  return id != null;
}

/**
 * Post-turn refresh: summarize the most recently active threads that have new
 * messages past their summary watermark (normally just the thread the user was
 * chatting in). Runs from the distill debounce.
 */
export async function refreshRecentSummaries(llm: LlmClient, maxThreads = 3): Promise<number> {
  if (!isRecallEnabled()) return 0;
  let written = 0;
  for (const { threadId } of getThreadsNeedingSummary(maxThreads, 'newest')) {
    if (await refreshThreadSummary(threadId, llm)) written += 1;
  }
  return written;
}

/**
 * Dormant backfill: the same refresh, oldest-activity first, for threads that
 * predate summaries (or fell behind while the app was closed). Bounded per pass;
 * the scheduler in index.ts runs it while the user is idle.
 */
export async function backfillSummaries(llm: LlmClient, maxThreads = 3): Promise<number> {
  if (!isRecallEnabled()) return 0;
  let written = 0;
  for (const { threadId } of getThreadsNeedingSummary(maxThreads, 'oldest')) {
    if (await refreshThreadSummary(threadId, llm)) written += 1;
  }
  return written;
}
