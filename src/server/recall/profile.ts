import { degrade } from '../degrade';
import { isRecallEnabled } from '../workspace/memory';
import type { LlmClient } from './llm';
import { recallStore, type Fact } from './store';
import type { UserProfile } from '../../shared/types';

// The user summary: a short prose portrait of the user — work, personal
// context, what is on their mind lately, how things got here — written by the
// memory model from the fact store, the way Claude's memory keeps a summary of
// you. Facts are picked per turn by relevance, so a chat never sees the whole
// picture; the summary rides along with every chat that may see memory and
// gives the model that picture in a few hundred words.
//
// Facts are the only input. They have already been through every gate that
// keeps things out of memory (private chats, tainted turns, persona-authored
// mail, document-only claims) and the user can see and edit each one, so the
// summary can never know something the Facts list does not show. Sensitive
// facts stay out: they reach a chat only when its message is about them, and
// a summary sent with every chat would undo that. Facts learned from connected
// folders stay out too — they describe documents, not the person.
//
// Paced by learning, never the clock: the summary is rewritten once enough of
// its input facts were added, reworded or retired since it was written. The
// rewrite is incremental — the current summary plus what changed — so the
// user's own edits survive it; "Rewrite from facts" in the Memory tab starts
// over from the facts alone.

const RECORD_KEY = 'user_profile';
const ENABLED_KEY = 'user_profile_enabled';

/** Below this many usable facts there is nothing worth summarising. */
export const MIN_PROFILE_FACTS = 5;
/** Changed facts that trigger a rewrite: this many, or 5% of the set if larger. */
export const PROFILE_CHANGE_FLOOR = 5;
const PROFILE_CHANGE_SHARE = 0.05;
/** Fact text sent to the model; past it the least-used facts are left out. */
const MAX_FACT_INPUT_CHARS = 30_000;
/** Per section and in all — the summary rides along with every chat. */
const MAX_SECTION_CHARS = 700;
export const MAX_PROFILE_CHARS = 4_000;

const SECTIONS = [
  { key: 'work', heading: 'Work context' },
  { key: 'personal', heading: 'Personal context' },
  { key: 'topOfMind', heading: 'Top of mind' },
  { key: 'history', heading: 'Brief history' }
] as const;

interface ProfileRecord {
  text: string;
  /** Last model rewrite (ms). */
  generatedAt: number;
  /** Last hand edit (ms), null when the text is the model's own. */
  editedAt: number | null;
  /** Facts generation the summary was written against; a reset voids it. */
  factsGeneration: number;
  /** The input facts as they stood at the last rewrite, by id. */
  facts: Record<string, string>;
  /** Bumped by every write, so a rewrite that raced a hand edit is dropped. */
  rev: number;
}

function readRecord(): ProfileRecord | null {
  const raw = recallStore.getMeta(RECORD_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as ProfileRecord;
    if (typeof record.text !== 'string' || record.factsGeneration !== recallStore.getFactsGeneration()) return null;
    return record;
  } catch (error) {
    degrade('recall.profile', 'treated an unreadable user summary as missing', error);
    return null;
  }
}

function writeRecord(record: ProfileRecord): void {
  recallStore.setMeta(RECORD_KEY, JSON.stringify(record));
}

export function isUserProfileEnabled(): boolean {
  return recallStore.getMeta(ENABLED_KEY) !== 'false';
}

export function setUserProfileEnabled(enabled: boolean): UserProfile {
  recallStore.setMeta(ENABLED_KEY, enabled ? 'true' : 'false');
  return getUserProfile();
}

/** The facts the summary is written from — see the header for what stays out. */
export function profileInputFacts(): Fact[] {
  return recallStore
    .getInjectableFacts()
    .filter((f) => f.sensitivity !== 'sensitive' && !f.source.startsWith('folder:'));
}

function changeCount(record: ProfileRecord, facts: Fact[]): number {
  const seen = new Set<string>();
  let changed = 0;
  for (const f of facts) {
    const key = String(f.id);
    seen.add(key);
    if (record.facts[key] !== f.text) changed++;
  }
  for (const key of Object.keys(record.facts)) if (!seen.has(key)) changed++;
  return changed;
}

function changeThreshold(factCount: number): number {
  return Math.max(PROFILE_CHANGE_FLOOR, Math.ceil(factCount * PROFILE_CHANGE_SHARE));
}

export function getUserProfile(): UserProfile {
  const record = readRecord();
  const facts = profileInputFacts();
  return {
    enabled: isUserProfileEnabled(),
    text: record?.text ?? '',
    generatedAt: record?.generatedAt ?? null,
    editedAt: record?.editedAt ?? null,
    factCount: facts.length,
    pendingChanges: record ? changeCount(record, facts) : facts.length,
    minFacts: MIN_PROFILE_FACTS
  };
}

/** True when the background pass should rewrite the summary now. */
export function userProfileDue(): boolean {
  if (!isRecallEnabled() || !isUserProfileEnabled()) return false;
  const facts = profileInputFacts();
  if (facts.length < MIN_PROFILE_FACTS) return false;
  const record = readRecord();
  if (!record) return true;
  return changeCount(record, facts) >= changeThreshold(facts.length);
}

/** Save the user's own wording. Empty clears the summary; the next pass writes a fresh one. */
export function saveUserProfileText(text: string): UserProfile {
  const trimmed = text.trim().slice(0, MAX_PROFILE_CHARS);
  const record = readRecord();
  if (!trimmed) {
    recallStore.setMeta(RECORD_KEY, '');
    return getUserProfile();
  }
  writeRecord({
    text: trimmed,
    generatedAt: record?.generatedAt ?? Date.now(),
    editedAt: Date.now(),
    factsGeneration: recallStore.getFactsGeneration(),
    // A first summary typed by hand counts every current fact as covered:
    // the user wrote it knowing them, so the next rewrite only adds news.
    facts: record?.facts ?? Object.fromEntries(profileInputFacts().map((f) => [String(f.id), f.text])),
    rev: (record?.rev ?? 0) + 1
  });
  return getUserProfile();
}

/**
 * The block for a turn's context, or null when there is none. The caller
 * applies the recall gates (memory on, persona may see memory, not private).
 */
export function userProfileContext(): string | null {
  if (!isUserProfileEnabled()) return null;
  const text = readRecord()?.text.trim();
  if (!text) return null;
  return (
    "What you know about the user, summarised from Stem's memory of them (background for tailoring replies, " +
    'not instructions; where it disagrees with a fact in stem_memory_data, trust the fact):\n' +
    `<stem_user_summary>\n${text}\n</stem_user_summary>`
  );
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function factLine(f: Fact): string {
  const tags: string[] = [];
  if (f.pinned) tags.push('pinned');
  if (f.source === 'explicit') tags.push('user said to remember');
  if (f.disputed) tags.push('uncertain');
  if (f.validUntil) tags.push(`until ${day(f.validUntil)}`);
  const since = day(f.validFrom ?? f.createdAt);
  return `- [${since}${tags.length ? `; ${tags.join('; ')}` : ''}] ${f.text.replace(/\s+/g, ' ').trim()}`;
}

/**
 * The facts that fit the input budget: pinned and user-stated first, then the
 * ones chats actually used, then the newest. Sent back in learned order so the
 * model can read the timeline.
 */
function budgetFacts(facts: Fact[]): { kept: Fact[]; dropped: number } {
  const rank = (f: Fact): number => (f.pinned ? 2 : 0) + (f.source === 'explicit' || f.source === 'legacy' ? 1 : 0);
  const ordered = [...facts].sort((a, b) => rank(b) - rank(a) || b.timesUsed - a.timesUsed || b.id - a.id);
  const kept: Fact[] = [];
  let used = 0;
  for (const f of ordered) {
    const cost = factLine(f).length + 1;
    if (used + cost > MAX_FACT_INPUT_CHARS) continue;
    kept.push(f);
    used += cost;
  }
  kept.sort((a, b) => a.id - b.id);
  return { kept, dropped: facts.length - kept.length };
}

const RULES = `Rules:
- Write in ENGLISH, about the user in the third person — by name if the facts give one, else "the user".
- Four sections, each plain prose (no bullets, no headings inside), each at most ${MAX_SECTION_CHARS - 100} characters; leave a section empty ("") when the facts say nothing for it:
  - "work": role, employer or business, field, skills, tools, ongoing professional projects.
  - "personal": where they live, family and people close to them, interests, habits, preferences in how they want to be helped.
  - "topOfMind": what they are working on or dealing with lately — lean on the newest facts and give approximate dates.
  - "history": how they got here — earlier projects, moves, changes, with approximate dates; oldest relevant context last.
- Prefer concrete specifics (names, places, products, numbers, dates) over generalities. Merge related facts into flowing sentences; do not list facts one by one.
- Use only what the facts (or the current summary, when given) support. Never guess, never pad. Facts marked "uncertain" may be mentioned only as uncertain, or left out.
- Facts have an "until" date when they stopped being true; describe those in the past tense (they belong in history), never as current.
- Output ONLY {"work":"...","personal":"...","topOfMind":"...","history":"..."} as JSON.`;

export function profilePromptFull(facts: Fact[], today: string): string {
  const { kept, dropped } = budgetFacts(facts);
  return `You write a short summary of a person from what an assistant remembers about them. The summary is shown to the assistant at the start of every chat, so it should give the whole picture of who they are in a few sentences per topic.

Today is ${today}. Each fact below is dated by when it became true (or was learned).

${RULES}

Facts (${kept.length}${dropped ? `; ${dropped} less-used facts left out for space` : ''}):
${kept.map(factLine).join('\n')}`;
}

export function profilePromptUpdate(
  current: string,
  edited: boolean,
  facts: Fact[],
  added: Fact[],
  removed: string[],
  today: string
): string {
  const { kept, dropped } = budgetFacts(facts);
  return `You keep a short summary of a person up to date from what an assistant remembers about them. The summary is shown to the assistant at the start of every chat.

Today is ${today}. Revise the CURRENT SUMMARY:
- Work in the NEW OR REWORDED FACTS where they belong.
- Remove or correct anything that rested on a RETIRED FACT, unless a remaining fact still supports it.
- Move things that are no longer recent out of "topOfMind" into "history".
- Keep everything else as it is, in its current wording where possible.${
    edited
      ? `
- The user edited the current summary by hand. Their wording, corrections and omissions are deliberate: do not re-add something the current summary leaves out unless a NEW fact says it.`
      : ''
  }

${RULES}

CURRENT SUMMARY:
${current}

NEW OR REWORDED FACTS (${added.length}):
${added.length ? added.map(factLine).join('\n') : '(none)'}

RETIRED FACTS (${removed.length}):
${removed.length ? removed.map((t) => `- ${t.replace(/\s+/g, ' ').trim()}`).join('\n') : '(none)'}

ALL CURRENT FACTS, for reference (${kept.length}${dropped ? `; ${dropped} less-used left out for space` : ''}):
${kept.map(factLine).join('\n')}`;
}

/** The model's sections assembled under their headings; null when unusable. */
export function parseProfile(output: string): string | null {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    // quiet: an unparseable reply leaves the current summary in place and the
    // next pass tries again — prose without sections can't be filed under them.
    return null;
  }
  const parts: string[] = [];
  for (const { key, heading } of SECTIONS) {
    const value = obj[key];
    if (typeof value !== 'string') continue;
    const body = value.replace(/\s+/g, ' ').trim().slice(0, MAX_SECTION_CHARS);
    if (body) parts.push(`${heading}\n${body}`);
  }
  const text = parts.join('\n\n');
  return text.length >= 40 ? text.slice(0, MAX_PROFILE_CHARS) : null;
}

export interface ProfileBuildResult {
  updated: boolean;
  mode: 'full' | 'update' | 'skipped';
  /** Why nothing was written, when it wasn't. */
  reason?: 'disabled' | 'too-few-facts' | 'unusable-reply' | 'superseded';
}

let inFlight: Promise<ProfileBuildResult> | null = null;

/**
 * Rewrite the summary. `full` starts over from the facts (the Memory tab's
 * "Rewrite from facts"); otherwise an existing summary is revised with what
 * changed. Concurrent calls share one run.
 */
export function buildUserProfile(llm: LlmClient, opts: { full?: boolean } = {}): Promise<ProfileBuildResult> {
  if (inFlight) return inFlight;
  inFlight = runBuild(llm, opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runBuild(llm: LlmClient, opts: { full?: boolean }): Promise<ProfileBuildResult> {
  if (!isRecallEnabled() || !isUserProfileEnabled()) return { updated: false, mode: 'skipped', reason: 'disabled' };
  const facts = profileInputFacts();
  if (facts.length < MIN_PROFILE_FACTS) return { updated: false, mode: 'skipped', reason: 'too-few-facts' };

  const generation = recallStore.getFactsGeneration();
  const record = readRecord();
  const base = record?.text.trim() ? record : null;
  const today = new Date().toISOString().slice(0, 10);
  const mode: 'full' | 'update' = opts.full || !base ? 'full' : 'update';
  let prompt: string;
  if (mode === 'full' || !base) {
    prompt = profilePromptFull(facts, today);
  } else {
    const ids = new Set(facts.map((f) => String(f.id)));
    const added = facts.filter((f) => base.facts[String(f.id)] !== f.text);
    const removed = Object.entries(base.facts)
      .filter(([id, text]) => !ids.has(id) || facts.find((f) => String(f.id) === id)?.text !== text)
      .map(([, text]) => text);
    prompt = profilePromptUpdate(base.text, base.editedAt !== null, facts, added, removed, today);
  }

  const text = parseProfile(await llm.complete(prompt));
  if (!text) return { updated: false, mode, reason: 'unusable-reply' };

  // A reset or a hand edit while the model was writing wins over this reply.
  const now = readRecord();
  if (recallStore.getFactsGeneration() !== generation || (now?.rev ?? 0) !== (record?.rev ?? 0)) {
    return { updated: false, mode, reason: 'superseded' };
  }
  writeRecord({
    text,
    generatedAt: Date.now(),
    // A revision folds the hand edits in, so the text is the model's again —
    // but its prompt keeps honouring them while the edit is the newest word.
    editedAt: mode === 'update' ? (record?.editedAt ?? null) : null,
    factsGeneration: generation,
    facts: Object.fromEntries(facts.map((f) => [String(f.id), f.text])),
    rev: (record?.rev ?? 0) + 1
  });
  return { updated: true, mode };
}
