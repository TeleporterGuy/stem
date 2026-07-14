import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillsRoot } from '../workspace/paths';
import { isRecallEnabled } from '../workspace/memory';
import { getMessagesForDistillFrom, getMeta, setMeta, type StoredMessage } from '../recall/store';
import { composeSkillMd, parseFront } from './curate';
import type { LlmClient } from '../recall/llm';

// The skills acquisition pass, mirroring recall/distill.ts for durable facts.
// The in-turn manage_skill instruction alone produces nothing (98 live sessions,
// zero calls — a model mid-answer never spends a tool call on optional
// bookkeeping), so this pass periodically re-reads conversation that's new since
// its last run and asks a single-purpose prompt whether the ASSISTANT worked out
// a reusable multi-step procedure worth keeping. Candidates are written as
// agent-authored SKILL.md files — the same shape manage_skill creates — so the
// existing curator (curate.ts) merges/patches/archives them over time.
//
// Deliberately a SEPARATE pass from fact distillation: the two prompts have
// opposite sourcing rules (facts must come from the USER's words and never the
// assistant's; skills are exactly the assistant's own procedures), and the fact
// prompt has already had one contamination bug — keeping them single-purpose
// keeps that class of regression out.

const WATERMARK = 'skill_distill_watermark';
const CURSOR_KEY = 'skill_distill_cursor_v2';
const MAX_MESSAGES_PER_RUN = 200;
const MAX_TRANSCRIPT_CHARS = 24_000;
const TRANSCRIPT_OVERLAP_CHARS = 256;
// Skip the model call (and leave the watermark, accumulating) until the new
// batch has enough substance to plausibly contain a worked-out procedure.
const MIN_BATCH_CHARS = 2_000;
// Per-pass cap: a transcript window very rarely yields even two genuine skills.
const MAX_SKILLS_PER_RUN = 2;
// Mirrors SKILL_MAX_BYTES in stem-mcp-extension.mjs (manage_skill's create cap).
const MAX_SKILL_BYTES = 15_000;
const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

interface SkillDistillCursor { messageId: number; offset: number }

function readCursor(): SkillDistillCursor {
  const raw = getMeta(CURSOR_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SkillDistillCursor>;
      if (Number.isInteger(parsed.messageId) && Number.isInteger(parsed.offset)) {
        return { messageId: Math.max(1, parsed.messageId!), offset: Math.max(0, parsed.offset!) };
      }
    } catch {
      // Fall through to the legacy whole-message watermark.
    }
  }
  const watermark = Number.parseInt(getMeta(WATERMARK) ?? '0', 10) || 0;
  return { messageId: watermark + 1, offset: 0 };
}

function buildTranscript(cursor: SkillDistillCursor): {
  transcript: string;
  messages: StoredMessage[];
  nextCursor: SkillDistillCursor;
} | null {
  const source = getMessagesForDistillFrom(cursor.messageId, MAX_MESSAGES_PER_RUN);
  if (source.length === 0) return null;
  let transcript = '';
  const messages: StoredMessage[] = [];
  let nextCursor = cursor;
  for (const message of source) {
    const offset = message.id === cursor.messageId ? Math.min(cursor.offset, message.text.length) : 0;
    const prefix = `${message.role === 'user' ? 'User' : 'Assistant'}: `;
    const room = MAX_TRANSCRIPT_CHARS - transcript.length - prefix.length - 1;
    if (room <= TRANSCRIPT_OVERLAP_CHARS && transcript) break;
    const take = Math.max(1, Math.min(message.text.length - offset, room));
    const end = offset + take;
    transcript += `${transcript ? '\n' : ''}${prefix}${message.text.slice(offset, end)}`;
    messages.push(message);
    if (end < message.text.length) {
      nextCursor = { messageId: message.id, offset: Math.max(offset + 1, end - TRANSCRIPT_OVERLAP_CHARS) };
      break;
    }
    nextCursor = { messageId: message.id + 1, offset: 0 };
    if (transcript.length >= MAX_TRANSCRIPT_CHARS) break;
  }
  return transcript ? { transcript, messages, nextCursor } : null;
}

const INSTRUCTIONS = `You review a transcript of chats between a user and their assistant, looking for reusable SKILLS the assistant should keep: multi-step procedures the ASSISTANT itself carried out and would plausibly repeat in future conversations.

A skill is worth keeping ONLY when all of these hold:
- The assistant worked out a NON-OBVIOUS, multi-step procedure — a sequence of tool calls, a workflow, a method it had to figure out (especially one it got right only after recovering from a misstep or dead end).
- It generalizes to future requests of the same kind, stated without one-off specifics (no names, dates, or values from this transcript unless they are part of the procedure itself).
- The transcript shows the procedure actually WORKED.

These are NOT skills: plain answers or explanations, facts or preferences of the user (those are remembered separately), one-off lookups, procedures that failed, or anything a competent assistant would do without instructions.

Output ONLY a JSON array (no prose, no markdown fences) of at most ${MAX_SKILLS_PER_RUN} skills:
[{"name": "short-dash-separated-name", "description": "one line: what it does AND when to use it", "content": "the procedure as numbered Markdown steps, ending with a verification step"}]

Most transcript windows contain NO new skill — when in doubt, output [].`;

export interface SkillCandidate {
  name: string;
  description: string;
  content: string;
}

/** Derive a filesystem slug from a free-text name (mirrors slugifySkill in the bridge). */
export function slugifySkill(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Parse the model's reply into validated skill candidates. Defensive: garbage → []. */
export function parseSkillCandidates(output: string): SkillCandidate[] {
  const trimmed = output.trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: SkillCandidate[] = [];
  const seen = new Set<string>();
  for (const c of parsed) {
    if (!c || typeof c !== 'object') continue;
    const name = (c as { name?: unknown }).name;
    const description = (c as { description?: unknown }).description;
    const content = (c as { content?: unknown }).content;
    if (typeof name !== 'string' || typeof description !== 'string' || typeof content !== 'string') continue;
    if (!description.trim() || !content.trim()) continue;
    const slug = slugifySkill(name);
    if (!VALID_SLUG.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ name: slug, description: description.trim(), content: content.trim() });
    if (out.length >= MAX_SKILLS_PER_RUN) break;
  }
  return out;
}

/** name + description of EVERY stored skill (any source) — the do-not-recreate list. */
function listAllSkills(): Array<{ slug: string; name: string; description: string }> {
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: Array<{ slug: string; name: string; description: string }> = [];
  for (const slug of entries) {
    let raw: string;
    try {
      raw = readFileSync(join(skillsRoot(), slug, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const fm = parseFront(raw);
    out.push({ slug, name: fm.name ?? slug, description: fm.description ?? '' });
  }
  return out;
}

/** Write one candidate as a new agent-authored skill. False when skipped (exists/too big). */
function writeSkill(c: SkillCandidate): boolean {
  const dir = join(skillsRoot(), c.name);
  if (existsSync(join(dir, 'SKILL.md'))) return false; // never overwrite — the curator dedups
  const md = composeSkillMd({
    name: c.name,
    description: c.description,
    body: c.content,
    version: 1,
    created: new Date().toISOString()
  });
  if (Buffer.byteLength(md, 'utf8') > MAX_SKILL_BYTES) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), md, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Distill reusable skills from messages captured since the last run. Returns the
 * number of skills written; the caller reloads the backend when it's non-zero so
 * pi picks up the new files. Watermark semantics match fact distillation: advance
 * past everything considered (even when nothing was worth keeping), stay put on a
 * model error so a later run retries — plus one extra state: a too-small batch is
 * left to ACCUMULATE (no model call, no advance) until it has enough substance.
 * `force` (the manual "collect now" path) processes even a tiny batch.
 */
export async function distillSkillsFromMessages(llm: LlmClient, opts: { force?: boolean } = {}): Promise<number> {
  if (!isRecallEnabled()) return 0;
  const cursor = readCursor();
  const batch = buildTranscript(cursor);
  if (!batch) return 0;
  const { messages, transcript } = batch;

  const totalChars = transcript.length;
  // A tail is continuation of an already-substantive message, not a new tiny
  // batch. Always finish it so the final characters cannot wait forever for a
  // future chat to push them through the noise gate.
  if (!opts.force && cursor.offset === 0 && totalChars < MIN_BATCH_CHARS && messages.length < MAX_MESSAGES_PER_RUN) {
    return 0;
  }

  const existing = listAllSkills();
  const existingBlock = existing.length
    ? `\n\nExisting skills (do NOT recreate or restate these):\n${existing
        .map((s) => `- ${s.slug}: ${s.description || s.name}`)
        .join('\n')}`
    : '';

  let candidates: SkillCandidate[];
  try {
    candidates = parseSkillCandidates(await llm.complete(`${INSTRUCTIONS}${existingBlock}\n\nTranscript:\n${transcript}`));
  } catch {
    // Leave the watermark unmoved so a later run retries these messages.
    return 0;
  }

  let written = 0;
  for (const c of candidates) if (writeSkill(c)) written += 1;

  // Advance through exactly the characters present in the successful prompt.
  setMeta(CURSOR_KEY, JSON.stringify(batch.nextCursor));
  setMeta(WATERMARK, String(Math.max(0, batch.nextCursor.messageId - 1)));
  return written;
}

/**
 * Manual "collect now": force-process the entire message backlog in batches
 * (the background pass consumes one batch per turn; a user clicking the button
 * expects everything considered NOW). Stops when the watermark stops moving —
 * fully caught up, or a model error left it put for a background retry later.
 * Bounded as a runaway guard; at 200 messages per batch that covers a 2000-
 * message backlog per click.
 */
export async function drainSkillDistill(llm: LlmClient): Promise<number> {
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const before = getMeta(CURSOR_KEY) ?? getMeta(WATERMARK) ?? '0';
    total += await distillSkillsFromMessages(llm, { force: true });
    if ((getMeta(CURSOR_KEY) ?? getMeta(WATERMARK) ?? '0') === before) break;
  }
  return total;
}
