
import { buildMatchQuery, lexTokens } from './search-core';
import { getEmbeddingsClient } from './retrieval';
import { cosineSim } from './vector';
import { isRecallEnabled } from '../workspace/memory';
import { contradicts } from './reconcile';
import type { FactCategory, FactSensitivity } from '../../shared/types';
import type { LlmClient } from './llm';
import { recallStore, type StoredMessage, type TurnInjectedFacts } from './store';
const { factTermSearch, getDupCosine, getFacts, getFactDetails, getFactsByIds, getFactVectors, getFactsGeneration, getMessagesForDistillFrom, getMeta, getTidyThreshold, getUngradedTurnFacts, markTurnFactsGraded, recordFactUsage, setMeta, supersedeFact, createFactConflict, upsertFact, upsertFactVector } = recallStore;

// Level 1: the reflection pass. Periodically reads conversation that's new since
// its last run and distills durable, stable facts about the user into the facts
// table (always injected). Episodic specifics stay in Level 2 (search) — this is
// only the small "profile" layer.

const WATERMARK = 'distill_watermark';
export const CURSOR_KEY = 'distill_cursor_v2';
// Strike counter for replies that parse to nothing recognizable at the current
// cursor. The segment is retried (cursor unmoved) until MAX_PARSE_STRIKES, then
// abandoned — bounded, visible-in-meta loss instead of either silent loss on the
// first bad reply or a poison segment wedging distillation forever.
export const PARSE_STRIKES_KEY = 'distill_parse_strikes';
export const MAX_PARSE_STRIKES = 3;
const MAX_MESSAGES_PER_RUN = 200;
export const MAX_TRANSCRIPT_CHARS = 16000;
export const DISTILL_OVERLAP_CHARS = 256;

export interface DistillCursor { messageId: number; offset: number }
export interface DistillBatch {
  transcript: string;
  messages: StoredMessage[];
  nextCursor: DistillCursor;
}

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

export const DISTILL_INSTRUCTIONS = `You maintain a long-term memory of DURABLE facts about a user from a chat transcript. Each transcript entry includes a stable message id.

Extract STABLE, reusable facts ABOUT THE USER: their identity, contact details, personal circumstances (address, phone, important dates, health conditions, family/relationships, work), preferences, ongoing situations, projects, constraints, upcoming plans, and standing instructions. Phrase each as a short third-person statement ("The user ...").

Rules:
- Write every fact in ENGLISH, regardless of the transcript's language. Keep proper names, place names, and quoted identifiers as-is.
- Only state facts the USER revealed about themselves — directly, or via information retrieved on their behalf (e.g. their own emails). Such personal details ARE wanted; do not omit, redact, or soften them.
- CRITICAL: Never turn the ASSISTANT's own words into a user fact. The assistant's disclaimers, caution, hedging, redactions, or self-imposed behavior ("I left out identifiers", "I ignored spam") are NOT user preferences. Only record a preference or instruction if the USER explicitly stated it.
- Include only things likely still true in future conversations. EXCLUDE details of already-completed one-off tasks, ephemeral context, and anything already obvious.
- DO capture upcoming dated plans and commitments — trips, holidays, reservations, appointments, deadlines — WITH their key specifics: dates, destination and departure point, who is going, booking references. These stay relevant until the date has passed. Resolve relative dates ("tomorrow", "next Friday") to absolute dates using the message dates and today's date.
- Do NOT record standing behavioral directives or response-style preferences (how long or short replies should be, tone, output format, language style, whether to use components). Those are managed separately as the user's custom instructions, NOT as facts — leave them out entirely.
- If a new claim clearly replaces a known fact, include that fact id in supersedesFactIds. If the conflict is ambiguous, include it in conflictsWithFactIds instead.
- Never include credentials, payment secrets, recovery phrases, or government identifiers. Addresses, contact details, health, and finance are allowed but must use sensitivity "sensitive".
- For every claim cite only message ids present in the transcript.
- SECOND DUTY — fact-usage grading. The prompt may include an "Injected facts per assistant reply" section listing, for some assistant messages, the stored facts that were available when that reply was written. For each listed message, judge which of those facts VISIBLY informed the reply's content (its recommendations, specifics, or phrasing) and report them in factUsage. Merely being available does not count; when none were used, report an empty usedFactIds. Grade only the listed messages and only their listed fact ids.
- Output ONLY {"claims":[...],"factUsage":[...]} where each claim is:
  {"text":"The user ...","category":"identity|preference|relationship|work|project|health|finance|location|schedule|other","sensitivity":"standard|sensitive","validUntil":"YYYY-MM-DD or null","evidenceMessageIds":[1],"supersedesFactIds":[],"conflictsWithFactIds":[]}
  and each factUsage entry is {"messageId":1,"usedFactIds":[2]}. Omit factUsage (or use []) when no injected-facts section is present.
If there is nothing new and durable, output {"claims":[]}.`;

// Fact text is normally English (the prompt demands it), but quoted identifiers
// and note text pass through verbatim — so the deny-list also carries Slovak/
// Czech/German terms. JS \b is ASCII-only, so the accented terms need
// Unicode-aware boundaries: letter-lookarounds plus the /u flag. Stem patterns
// (trailing \p{L}*) absorb declensions (heslo/hesla/heslom, rodného čísla...).
const SECRET_RE =
  /(?<!\p{L})(?:password|passcode|pin|api[_ -]?key|auth token|access token|bearer token|secret key|private key|seed phrase|recovery phrase|credit card|card number|cvv|ssn|social security|national id|government id|birth number|hesl\p{L}+|prístupov\p{L}+ (?:kód|fráz\p{L}+)|rodn\p{L}+ čísl\p{L}+|občiansk\p{L}+ preukaz\p{L}*|platobn\p{L}+ kart\p{L}+|kreditn\p{L}+ kart\p{L}+|číslo karty|passwort\p{L}*|kennwort\p{L}*|kreditkarte\p{L}*|kartennummer\p{L}*|personalausweis\p{L}*|sozialversicherung\p{L}*)(?!\p{L})/iu;

export interface DistilledClaim {
  text: string;
  category: FactCategory;
  sensitivity: FactSensitivity;
  validUntil: number | null;
  evidenceMessageIds: number[];
  supersedesFactIds: number[];
  conflictsWithFactIds: number[];
}

const CATEGORIES = new Set<FactCategory>([
  'identity', 'preference', 'relationship', 'work', 'project', 'health', 'finance', 'location', 'schedule', 'other'
]);

function cleanIds(v: unknown): number[] {
  return Array.isArray(v) ? [...new Set(v.filter((n): n is number => Number.isInteger(n)))] : [];
}

function parseValidUntil(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const ms = Date.parse(`${v.trim()}T23:59:59Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** parseClaims plus whether the reply was structurally recognizable at all. */
export interface ParsedDistillOutput {
  claims: DistilledClaim[];
  /**
   * True when the reply contained a parseable {"claims":[...]} object (even an
   * empty one) or the legacy bullet/JSON-array fallback matched. False means
   * the model returned garbage — "no new facts" is always representable as
   * {"claims":[]}, so an unrecognizable reply is a model failure, not an empty
   * segment, and the caller must not consume the transcript on its strength.
   */
  recognized: boolean;
}

// The default cap suits distilled single statements; the note-extraction path
// passes a higher one because a coherent list kept as one fact runs longer.
export function parseClaims(output: string, maxTextLength = 300): DistilledClaim[] {
  return parseDistillOutput(output, maxTextLength).claims;
}

export function parseDistillOutput(output: string, maxTextLength = 300): ParsedDistillOutput {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  let raw: unknown[] = [];
  let recognized = false;
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(trimmed.slice(start, end + 1)) as { claims?: unknown };
      if (Array.isArray(obj.claims)) {
        raw = obj.claims;
        recognized = true;
      }
    } catch {
      // Legacy/bullet fallback below.
    }
  }
  if (raw.length === 0) {
    const fallback = parseFacts(output).map((text) => ({ text }));
    if (fallback.length > 0) {
      raw = fallback;
      recognized = true;
    }
  }
  const seen = new Set<string>();
  const out: DistilledClaim[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const r = value as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim() : '';
    const key = text.toLowerCase();
    if (text.length < 3 || text.length > maxTextLength || SECRET_RE.test(text) || seen.has(key)) continue;
    seen.add(key);
    const category = CATEGORIES.has(r.category as FactCategory) ? r.category as FactCategory : 'other';
    const sensitiveByCategory = ['health', 'finance', 'location', 'schedule'].includes(category);
    out.push({
      text,
      category,
      sensitivity: r.sensitivity === 'sensitive' || sensitiveByCategory ? 'sensitive' : 'standard',
      validUntil: parseValidUntil(r.validUntil),
      evidenceMessageIds: cleanIds(r.evidenceMessageIds),
      supersedesFactIds: cleanIds(r.supersedesFactIds),
      conflictsWithFactIds: cleanIds(r.conflictsWithFactIds)
    });
  }
  return { claims: out, recognized };
}

/** One graded assistant reply: which injected facts it visibly used. */
export interface FactUsageGrade {
  messageId: number;
  usedFactIds: number[];
}

/**
 * Parse the model's factUsage grades from the same reply parseClaims reads.
 * Absent/malformed → [] (never an error): grading rides free on the distill
 * call, and the lexical fallback covers a model that ignored the second duty.
 */
export function parseFactUsage(output: string): FactUsageGrade[] {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1)) as { factUsage?: unknown };
    if (!Array.isArray(obj.factUsage)) return [];
    return obj.factUsage.flatMap((v) => {
      if (!v || typeof v !== 'object') return [];
      const r = v as Record<string, unknown>;
      return Number.isInteger(r.messageId)
        ? [{ messageId: r.messageId as number, usedFactIds: cleanIds(r.usedFactIds) }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * Model-free usage heuristic: a fact counts as used when the reply contains at
 * least two of its content tokens, or at least half of them (a short fact like
 * "The user drives a Škoda" only has a couple). Noisier than the LLM grade but
 * available even when the model ignores the grading duty.
 */
export function lexicalUsage(factText: string, replyText: string): boolean {
  const factTokens = lexTokens(factText, 3).filter((t) => t !== 'user');
  if (factTokens.length === 0) return false;
  const replyTokens = new Set(lexTokens(replyText, 3));
  const hits = factTokens.filter((t) => replyTokens.has(t)).length;
  return hits >= 2 || hits / factTokens.length >= 0.5;
}

/** Cap grading work per distill call — a huge backlog converges over passes. */
const MAX_GRADED_TURNS_PER_RUN = 8;

// The lexical fallback abstains on replies shorter than this: against a "Done."
// -class acknowledgement it would mark every injected fact unused, piling
// noise-driven penalties onto whatever facts happen to be injected often. An
// abstained row stays ungraded (no signal either way) and ages out via the
// 30-day prune. Model grades are exempt — they can judge short replies.
export const MIN_LEXICAL_GRADE_REPLY_CHARS = 60;

/**
 * The ungraded injected-fact rows whose assistant reply appears in this batch,
 * paired with that reply. Only fully known pairs are gradable.
 */
function gradableTurns(batch: DistillBatch): Array<{ row: TurnInjectedFacts; reply: StoredMessage }> {
  const assistantByTurn = new Map<string, StoredMessage>();
  for (const m of batch.messages) {
    if (m.role === 'assistant' && m.turnId) assistantByTurn.set(m.turnId, m);
  }
  if (assistantByTurn.size === 0) return [];
  return getUngradedTurnFacts([...assistantByTurn.keys()])
    .slice(0, MAX_GRADED_TURNS_PER_RUN)
    .map((row) => ({ row, reply: assistantByTurn.get(row.turnId)! }));
}

/** The "Injected facts per assistant reply" prompt section. Empty when nothing to grade. */
function buildUsageBlock(turns: Array<{ row: TurnInjectedFacts; reply: StoredMessage }>): string {
  const lines: string[] = [];
  for (const { row, reply } of turns) {
    const facts = getFactsByIds(row.factIds);
    if (facts.length === 0) continue;
    const listed = facts.map((f) => `[fact:${f.id}] ${f.text.slice(0, 200)}`).join('; ');
    lines.push(`[message:${reply.id}] was written with these facts available: ${listed}`);
  }
  return lines.length
    ? `\n\nInjected facts per assistant reply (grade these in factUsage):\n${lines.join('\n')}`
    : '';
}

/**
 * Apply one distill reply's usage grades: every listed fact gains an injection
 * count, the used subset a use count; the row is then marked graded so it can
 * never double-count. Falls back to the lexical heuristic for turns the model
 * didn't grade. Counters only — confidence is never touched.
 */
function applyUsageGrades(
  turns: Array<{ row: TurnInjectedFacts; reply: StoredMessage }>,
  grades: FactUsageGrade[]
): void {
  const byMessageId = new Map(grades.map((g) => [g.messageId, g]));
  for (const { row, reply } of turns) {
    const graded = byMessageId.get(reply.id);
    if (!graded && reply.text.length < MIN_LEXICAL_GRADE_REPLY_CHARS) continue;
    const injected = new Set(row.factIds);
    const used = graded
      ? graded.usedFactIds.filter((id) => injected.has(id))
      : getFactsByIds(row.factIds).filter((f) => lexicalUsage(f.text, reply.text)).map((f) => f.id);
    recordFactUsage(row.factIds, used, reply.ts);
    markTurnFactsGraded(row.threadId, row.turnId);
  }
}

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

export const KNOWN_FACTS_CAP = 100;
// How many of the cap's slots relevance may claim before recency fills the rest,
// and how many transcript terms feed the lexical probe (facts are few and the
// FTS index small, so a wide OR query stays cheap).
const KNOWN_FACTS_RELEVANT = 60;
const KNOWN_FACTS_QUERY_TERMS = 200;

/**
 * The "you already know this" hint prepended to an extraction prompt. Bounded at
 * KNOWN_FACTS_CAP on purpose: a dedup hint, not authority, and it caps prompt
 * size. Recency alone stops scaling past the cap — an old fact the current
 * transcript touches falls out of the window and gets restated — so when the
 * transcript is provided, facts sharing terms with it are pulled in first
 * (those are exactly the ones a restatement would duplicate) and recency fills
 * the remainder. Shared with the rebuild pass — an extractor that isn't told to
 * skip known facts restates them under new wording, minting duplicate rows and
 * bogus "this supersedes that" links between two facts that say the same thing.
 */
export function knownFactsBlock(context?: string): string {
  const picked: Array<{ id: number; source: string; text: string }> = [];
  const seen = new Set<number>();
  const add = (facts: Array<{ id: number; source: string; text: string }>) => {
    for (const f of facts) {
      if (picked.length >= KNOWN_FACTS_CAP) break;
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      picked.push(f);
    }
  };
  if (context) {
    const match = buildMatchQuery(lexTokens(context, 3).slice(0, KNOWN_FACTS_QUERY_TERMS).join(' '));
    if (match) add(factTermSearch(match, KNOWN_FACTS_RELEVANT));
  }
  add(getFacts(KNOWN_FACTS_CAP));
  const known = picked.map((f) => `- [fact:${f.id} source:${f.source}] ${f.text}`).join('\n');
  return known ? `\n\nKnown facts (do not restate these):\n${known}` : '';
}

/** Parse strikes recorded for exactly this cursor position; anything else → 0. */
function readParseStrikes(cursor: DistillCursor): number {
  const raw = getMeta(PARSE_STRIKES_KEY);
  if (!raw) return 0;
  try {
    const p = JSON.parse(raw) as Partial<DistillCursor & { count: number }>;
    if (p.messageId === cursor.messageId && p.offset === cursor.offset && Number.isInteger(p.count)) {
      return Math.max(0, p.count!);
    }
  } catch {
    // Stale/corrupt → no strikes.
  }
  return 0;
}

export function readDistillCursor(): DistillCursor {
  const raw = getMeta(CURSOR_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<DistillCursor>;
      if (Number.isInteger(parsed.messageId) && Number.isInteger(parsed.offset)) {
        return { messageId: Math.max(1, parsed.messageId!), offset: Math.max(0, parsed.offset!) };
      }
    } catch {
      // Bootstrap from the v1 watermark below.
    }
  }
  const old = Number.parseInt(getMeta(WATERMARK) ?? '0', 10) || 0;
  return { messageId: old + 1, offset: 0 };
}

export function buildDistillBatch(cursor: DistillCursor, maxChars = MAX_TRANSCRIPT_CHARS): DistillBatch | null {
  const source = getMessagesForDistillFrom(cursor.messageId, MAX_MESSAGES_PER_RUN);
  if (source.length === 0) return null;
  let transcript = '';
  const included: StoredMessage[] = [];
  let next: DistillCursor = cursor;

  for (const message of source) {
    const offset = message.id === cursor.messageId ? Math.min(cursor.offset, message.text.length) : 0;
    const prefix = `[message:${message.id} date:${new Date(message.ts * 1000).toISOString().slice(0, 10)} role:${message.role}] `;
    const room = maxChars - transcript.length - prefix.length - 1;
    if (room <= DISTILL_OVERLAP_CHARS && transcript) break;
    const take = Math.max(1, Math.min(message.text.length - offset, room));
    const end = offset + take;
    transcript += `${transcript ? '\n' : ''}${prefix}${message.text.slice(offset, end)}`;
    included.push(message);
    if (end < message.text.length) {
      next = { messageId: message.id, offset: Math.max(offset + 1, end - DISTILL_OVERLAP_CHARS) };
      break;
    }
    next = { messageId: message.id + 1, offset: 0 };
    if (transcript.length >= maxChars) break;
  }
  return transcript ? { transcript, messages: included, nextCursor: next } : null;
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
  const cursor = readDistillCursor();
  const batch = buildDistillBatch(cursor);
  if (!batch) return 0;
  const factsGeneration = getFactsGeneration();

  const advanceWithoutWriting = () => {
    setMeta(CURSOR_KEY, JSON.stringify(batch.nextCursor));
    setMeta(WATERMARK, String(Math.max(0, batch.nextCursor.messageId - 1)));
    return 0;
  };

  // Show the model what it already knows so it returns only new/corrected facts
  // (curbs reworded duplicates the norm-based dedup can't catch). Raw message
  // texts feed the relevance probe — the transcript's [message:...] prefixes
  // would pollute it with metadata tokens.
  const knownBlock = knownFactsBlock(batch.messages.map((m) => m.text).join('\n'));

  // Usage grading rides on the same call: the batch's assistant replies whose
  // injected-fact sets are still ungraded get listed for the model to judge.
  const usageTurns = gradableTurns(batch);
  const usageBlock = buildUsageBlock(usageTurns);

  let claims: DistilledClaim[] = [];
  let usageGrades: FactUsageGrade[] = [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const reply = await llm.complete(
      `${DISTILL_INSTRUCTIONS}\n\nToday's date: ${today}.${knownBlock}${usageBlock}\n\nTranscript:\n${batch.transcript}`
    );
    const parsed = parseDistillOutput(reply);
    if (!parsed.recognized) {
      // Garbage reply. Retry this exact segment on a later run (grading rides
      // along: ungraded rows stay ungraded) — but only MAX_PARSE_STRIKES times,
      // then give the segment up so it can't wedge distillation forever.
      const strikes = readParseStrikes(cursor) + 1;
      if (strikes < MAX_PARSE_STRIKES) {
        setMeta(PARSE_STRIKES_KEY, JSON.stringify({ ...cursor, count: strikes }));
        return 0;
      }
      setMeta(PARSE_STRIKES_KEY, '');
      return advanceWithoutWriting();
    }
    setMeta(PARSE_STRIKES_KEY, '');
    claims = parsed.claims;
    usageGrades = parseFactUsage(reply);
  } catch {
    // Leave the cursor unmoved so a later run retries this exact segment
    // (grading rides along: ungraded rows stay ungraded).
    return 0;
  }
  // The user may have cleared facts while the model call was in flight. Treat
  // the reviewed transcript as consumed, but never resurrect its facts.
  if (getFactsGeneration() !== factsGeneration) return advanceWithoutWriting();
  applyUsageGrades(usageTurns, usageGrades);

  const byId = new Map(batch.messages.map((m) => [m.id, m]));
  // Legacy string-array output has no citations. For compatibility, bind those
  // claims to the segment's user messages — but as provenance only, never
  // authority: a claim whose citations were absent or didn't resolve may be
  // hallucinated, so it must not inherit the confident direct-user treatment
  // (0.9 confidence + silent supersede) from backfilled evidence.
  const uncited = new Set<DistilledClaim>();
  for (const claim of claims) {
    claim.evidenceMessageIds = claim.evidenceMessageIds.filter((id) => byId.has(id));
    if (claim.evidenceMessageIds.length === 0) {
      uncited.add(claim);
      claim.evidenceMessageIds = batch.messages.filter((m) => m.role === 'user').map((m) => m.id);
      if (claim.evidenceMessageIds.length === 0) claim.evidenceMessageIds = batch.messages.map((m) => m.id);
    }
  }

  // Write-time semantic dedup — never a silent drop. A near-duplicate is still
  // inserted (the LLM consolidation pass stays the only thing that ever removes
  // a fact, keeping the protected-facts guarantees in one place); it just forces
  // the dirty counter past the tidy threshold so consolidation adjudicates on
  // the very next debounce instead of waiting for more facts to pile up.
  const scored = await scoreCandidatesAgainstFacts(claims.map((c) => c.text));
  if (getFactsGeneration() !== factsGeneration) return advanceWithoutWriting();
  const dupThreshold = getDupCosine();
  let dupSeen = false;
  let i = -1;
  for (const claim of claims) {
    if (getFactsGeneration() !== factsGeneration) return advanceWithoutWriting();
    i += 1;
    const evidenceMessages = claim.evidenceMessageIds.map((id) => byId.get(id)).filter((m): m is StoredMessage => !!m);
    const directUser = !uncited.has(claim) && evidenceMessages.some((m) => m.role === 'user');
    const id = upsertFact(claim.text, {
      source: 'distilled',
      category: claim.category,
      sensitivity: claim.sensitivity,
      confidence: directUser ? 0.9 : 0.55,
      validUntil: claim.validUntil,
      evidence: evidenceMessages.map((m) => ({
        messageId: m.id,
        threadId: m.threadId,
        role: m.role,
        timestamp: m.ts,
        excerpt: m.text,
        origin: directUser && m.role === 'user' ? 'user_message' : 'assistant_claim'
      }))
    });
    if (scored && id != null) {
      // We already hold this fact's fresh passage vector — cache it so neither
      // the ready-hook backfill nor inject's lazy path re-embeds it.
      upsertFactVector(id, scored.model, scored.vecs[i]);
      if (scored.maxSims[i] >= dupThreshold) dupSeen = true;
    }
    if (id != null) {
      for (const targetId of claim.supersedesFactIds) {
        const target = getFactDetails(targetId);
        if (!target || target.id === id) continue;
        if (directUser && target.source !== 'explicit') supersedeFact(target.id, id);
        // No authority to supersede — but the extractor's say-so isn't proof the two
        // facts disagree, so check before making the user adjudicate.
        else if (await contradicts(target.text, claim.text, llm)) {
          if (getFactsGeneration() !== factsGeneration) return advanceWithoutWriting();
          createFactConflict(target.id, id, 'A newer memory may contradict this fact.');
        }
      }
      for (const targetId of claim.conflictsWithFactIds) {
        if (targetId !== id && getFactDetails(targetId)) {
          createFactConflict(targetId, id, 'The available evidence is ambiguous.');
        }
      }
    }
  }

  if (getFactsGeneration() !== factsGeneration) return advanceWithoutWriting();

  // Mark new material for the consolidation pass to clean up later.
  if (claims.length > 0) {
    let pending = (Number.parseInt(getMeta(PENDING_KEY) ?? '0', 10) || 0) + claims.length;
    // A detected near-duplicate fast-tracks consolidation. max() with the
    // threshold respects a 0 threshold (auto tidy-up disabled → manual only).
    if (dupSeen) pending = Math.max(pending, getTidyThreshold());
    setMeta(PENDING_KEY, String(pending));
  }

  // Advance through exactly the characters the successful prompt contained.
  setMeta(CURSOR_KEY, JSON.stringify(batch.nextCursor));
  // Keep the old watermark moving for downgrade compatibility, but never use it
  // to decide v2 progress.
  setMeta(WATERMARK, String(Math.max(0, batch.nextCursor.messageId - 1)));
  return claims.length;
}
