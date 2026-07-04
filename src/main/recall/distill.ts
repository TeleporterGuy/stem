import {
  getDupCosine,
  getFacts,
  getFactVectors,
  getMessagesForDistill,
  getMeta,
  getTidyThreshold,
  setMeta,
  upsertFact,
  upsertFactVector
} from './store';
import { getEmbeddingsClient } from './retrieval';
import { cosineSim } from './vector';
import { isRecallEnabled } from '../workspace/memory';
import type { LlmClient } from './llm';

// Level 1: the reflection pass. Periodically reads conversation that's new since
// its last run and distills durable, stable facts about the user into the facts
// table (always injected). Episodic specifics stay in Level 2 (search) — this is
// only the small "profile" layer.

const WATERMARK = 'distill_watermark';
const MAX_MESSAGES_PER_RUN = 200;
const MAX_TRANSCRIPT_CHARS = 16000;

// Counts durable facts written since the last consolidation pass — the dirty
// signal that gates consolidation (see consolidate.ts). Distillation is the only
// writer of `distilled` facts, so it owns the counter.
export const PENDING_KEY = 'consolidate_pending';

/**
 * True when enough new facts have piled up to warrant a consolidation pass. The
 * threshold is user-configurable (Facts tab); 0 disables automatic tidy-up, so
 * consolidation then only runs from the manual "Tidy up" button.
 */
export function shouldConsolidate(): boolean {
  const threshold = getTidyThreshold();
  if (threshold <= 0) return false;
  return (Number.parseInt(getMeta(PENDING_KEY) ?? '0', 10) || 0) >= threshold;
}

const INSTRUCTIONS = `You maintain a long-term memory of DURABLE facts about a user, from a chat transcript. This is a PRIVATE personal assistant used by one person on their own device — knowing a lot about the user is the whole point, so capture genuinely personal details that make future help better.

Extract STABLE, reusable facts ABOUT THE USER: their identity, contact details, personal circumstances (address, phone, important dates, health conditions, family/relationships, work), preferences, ongoing situations, projects, constraints, upcoming plans, and standing instructions. Phrase each as a short third-person statement ("The user ...").

Rules:
- Only state facts the USER revealed about themselves — directly, or via information retrieved on their behalf (e.g. their own emails). Such personal details ARE wanted; do not omit, redact, or soften them.
- CRITICAL: Never turn the ASSISTANT's own words into a user fact. The assistant's disclaimers, caution, hedging, redactions, or self-imposed behavior ("I left out identifiers", "I ignored spam") are NOT user preferences. Only record a preference or instruction if the USER explicitly stated it.
- Include only things likely still true in future conversations. EXCLUDE details of already-completed one-off tasks, ephemeral context, and anything already obvious.
- DO capture upcoming dated plans and commitments — trips, holidays, reservations, appointments, deadlines — WITH their key specifics: dates, destination and departure point, who is going, booking references. These stay relevant until the date has passed. Resolve relative dates ("tomorrow", "next Friday") to absolute dates using the message dates and today's date.
- Do NOT record standing behavioral directives or response-style preferences (how long or short replies should be, tone, output format, language style, whether to use components). Those are managed separately as the user's custom instructions, NOT as facts — leave them out entirely.
- If the user corrected an earlier assumption, state the corrected truth.
- Do NOT restate facts already in "Known facts" below; output only NEW facts or corrections to existing ones.
- Never include CREDENTIALS (passwords, PINs, API keys, tokens, card numbers, seed/recovery phrases). Ordinary personal identifiers (national ID / birth number, address, phone, email) are allowed.
- Output ONLY a JSON array of strings. No prose, no markdown fences. If there is nothing new and durable, output [].`;

const SECRET_RE =
  /\b(?:password|passcode|api[_ -]?key|auth token|access token|bearer token|secret key|private key|seed phrase|recovery phrase|credit card|card number|cvv)\b/i;

/** Parse the model's reply into clean fact strings (JSON array, with a bullet fallback). */
export function parseFacts(output: string): string[] {
  const raw: string[] = [];
  const trimmed = output.trim();

  // Preferred: a JSON array somewhere in the reply.
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const arr = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(arr)) for (const v of arr) if (typeof v === 'string') raw.push(v);
    } catch {
      // fall through to bullet parsing
    }
  }
  // Fallback: bullet/numbered lines.
  if (raw.length === 0) {
    for (const line of trimmed.split('\n')) {
      const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) raw.push(m[1]);
    }
  }

  const seen = new Set<string>();
  const facts: string[] = [];
  for (const r of raw) {
    const f = r.replace(/\s+/g, ' ').trim();
    const key = f.toLowerCase();
    if (f.length < 3 || f.length > 300 || seen.has(key) || SECRET_RE.test(f)) continue;
    seen.add(key);
    facts.push(f);
  }
  return facts;
}

/**
 * Max cosine of each candidate fact against the cached fact vectors — the
 * write-time near-duplicate signal. The snapshot of existing vectors is taken
 * BEFORE anything is written, and candidates are also compared to EARLIER
 * candidates in the same batch (the LLM sometimes emits two rewordings at once).
 * Candidates are embedded 'passage'-kind: fact↔fact comparison is symmetric, so
 * both sides use the passage prefix — never 'query'. Returns null when
 * embeddings are unavailable or anything fails, and the caller takes exactly the
 * pre-dedup path; distillation never breaks on a dead embedder.
 */
async function scoreCandidatesAgainstFacts(
  candidates: string[]
): Promise<{ vecs: Float32Array[]; model: string; maxSims: number[] } | null> {
  if (candidates.length === 0) return null;
  try {
    const emb = getEmbeddingsClient();
    if (!emb || !(await emb.available())) return null;
    const model = (await emb.modelId()) ?? '';
    if (!model) return null;
    const vecs = await emb.embed(candidates, 'passage');
    const existing = [...getFactVectors(model).values()];
    const maxSims = vecs.map((v, i) => {
      let max = 0;
      for (const e of existing) max = Math.max(max, cosineSim(v, e));
      for (let j = 0; j < i; j++) max = Math.max(max, cosineSim(v, vecs[j]));
      return max;
    });
    return { vecs, model, maxSims };
  } catch {
    return null;
  }
}

/**
 * Distill durable facts from messages captured since the last run. Returns the
 * number of facts written. Safe to call repeatedly — advances a watermark so each
 * message is only processed once.
 */
export async function distillNewMessages(llm: LlmClient): Promise<number> {
  if (!isRecallEnabled()) return 0;
  const sinceId = Number.parseInt(getMeta(WATERMARK) ?? '0', 10) || 0;
  const messages = getMessagesForDistill(sinceId, MAX_MESSAGES_PER_RUN);
  if (messages.length === 0) return 0;

  // Each line carries its message date so the model can resolve relative dates
  // ("tomorrow", "next week") in older messages against when they were said.
  const transcript = messages
    .map((m) => `[${new Date(m.ts * 1000).toISOString().slice(0, 10)}] ${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n')
    .slice(0, MAX_TRANSCRIPT_CHARS);

  // Show the model what it already knows so it returns only new/corrected facts
  // (curbs reworded duplicates the norm-based dedup can't catch). Bounded at 100
  // (recency) on purpose: a dedup hint, not authoritative, and it caps prompt size.
  const known = getFacts(100).map((f) => `- ${f.text}`).join('\n');
  const knownBlock = known ? `\n\nKnown facts (do not restate these):\n${known}` : '';

  let facts: string[] = [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const reply = await llm.complete(
      `${INSTRUCTIONS}\n\nToday's date: ${today}.${knownBlock}\n\nTranscript:\n${transcript}`
    );
    facts = parseFacts(reply);
  } catch {
    // Leave the watermark unmoved so a later run retries these messages.
    return 0;
  }

  // Write-time semantic dedup — never a silent drop. A near-duplicate is still
  // inserted (the LLM consolidation pass stays the only thing that ever removes
  // a fact, keeping the protected-facts guarantees in one place); it just forces
  // the dirty counter past the tidy threshold so consolidation adjudicates on
  // the very next debounce instead of waiting for more facts to pile up.
  const scored = await scoreCandidatesAgainstFacts(facts);
  const dupThreshold = getDupCosine();
  let dupSeen = false;
  facts.forEach((fact, i) => {
    const id = upsertFact(fact, 'distilled');
    if (scored && id != null) {
      // We already hold this fact's fresh passage vector — cache it so neither
      // the ready-hook backfill nor inject's lazy path re-embeds it.
      upsertFactVector(id, scored.model, scored.vecs[i]);
      if (scored.maxSims[i] >= dupThreshold) dupSeen = true;
    }
  });

  // Mark new material for the consolidation pass to clean up later.
  if (facts.length > 0) {
    let pending = (Number.parseInt(getMeta(PENDING_KEY) ?? '0', 10) || 0) + facts.length;
    // A detected near-duplicate fast-tracks consolidation. max() with the
    // threshold respects a 0 threshold (auto tidy-up disabled → manual only).
    if (dupSeen) pending = Math.max(pending, getTidyThreshold());
    setMeta(PENDING_KEY, String(pending));
  }

  // Advance past everything we just considered (even if 0 facts — they had nothing durable).
  const maxId = messages.reduce((max, m) => Math.max(max, m.id), sinceId);
  setMeta(WATERMARK, String(maxId));
  return facts.length;
}
