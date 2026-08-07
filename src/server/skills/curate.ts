import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { skillsRoot } from '../workspace/paths';
import { isRecallEnabled } from '../workspace/memory';
import type { LlmClient } from '../recall/llm';
import { DISABLED_MARKER, syncSkillsIgnore } from './ignore';
import { saveSkill } from './store';
import { mergeUsage, pruneUsage, readUsage, type SkillsUsage } from './usage';

// Level-2 cleanup for self-authored skills, mirroring recall/consolidate.ts for
// durable facts. The assistant only ever ADDS or updates skills via manage_skill,
// so over time the library accumulates near-duplicate procedures and stale ones.
// This pass periodically asks the LLM for merge/archive operations, then applies
// them with the same KEEP-by-default posture and a drop-fraction guard.
//
// It used to also PATCH bodies, and no longer does. Body edits belong to the
// assistant at the moment it uses a skill and finds it wrong: that is when the
// evidence exists. A periodic pass rewriting bodies it has no failure evidence for
// can only degrade a working skill on the strength of how it reads — and it is the
// one mechanism that ran continuously over the library this rebuild deletes.
//
// It ONLY ever touches agent-authored skills (metadata.stem.source === 'agent').
// User-dropped and bundled skills are never read into the prompt nor modified.
// Archiving is reversible: it sets the same `.disabled` marker the Manage panel
// uses (see workspace/skills.ts) and republishes the ignore file (skills/ignore.ts),
// so pi stops loading the skill but the file stays.

// Below this many agent skills an automatic pass isn't worth a model call.
const MIN_SKILLS = 3;
// Reject the whole batch if it would retire more than this fraction of the set.
const MAX_DROP_FRACTION = 0.4;
// One-pass budget: skip (best effort) if the library is too large to fit one prompt.
const MAX_PROMPT_CHARS = 80_000;

export interface CurateResult {
  merged: number;
  archived: number;
}
const ZERO: CurateResult = { merged: 0, archived: 0 };

interface AgentSkill {
  slug: string;
  name: string;
  description: string;
  version: number;
  created: string;
  body: string;
  /** Consultations recorded since usage tracking began (0 = none recorded). */
  useCount: number;
  /** ISO timestamp of the most recent recorded use. */
  lastUsedAt?: string;
}

interface CurateOps {
  merge: { slugs: string[]; description: string; content: string }[];
  archive: string[];
}
const EMPTY_OPS: CurateOps = { merge: [], archive: [] };

const INSTRUCTIONS = `You maintain a library of an assistant's self-authored SKILL files. Each skill is a reusable procedure with a name, a one-line description (what it does and when to use it), and a step-by-step body. Over time the library accumulates near-duplicate skills and skills superseded by a better one.

Return ONLY a JSON object (no prose, no markdown fences) with this shape:
{
  "merge":   [{"slugs": ["winner-slug","loser-slug"], "description": "...", "content": "<combined body>"}],
  "archive": ["<slug of a stale/superseded/useless skill>"]
}

Rules:
- DEFAULT TO KEEP. Only act on skills you are confident are duplicates or superseded. If unsure, leave a skill out of both lists.
- merge: combine skills that cover the SAME task. The FIRST slug in "slugs" is kept, keeps its name, and is rewritten with your "description" and "content"; the rest are retired. List at least two slugs. Keep the body under 4096 bytes with the headings "## When to use", "## Steps", "## Verification", in that order.
- archive: only a skill made redundant or obsolete by another, or one that is clearly not a reusable procedure.
- Do NOT improve, tidy, or reword a body you are keeping. You cannot see whether it works; the assistant fixes a skill when it uses one and finds it wrong.
- Usage counts are advisory, never decisive on their own. A skill NEVER used since tracking began, created after tracking started and more than ~30 days ago, is a strong archive candidate. A skill that WAS used but has been dormant since is a WEAK signal — seasonal or rarely-needed procedures are legitimate; keep it by default.
- Use ONLY the slugs listed below. Never invent a skill or a slug.
- If nothing needs changing, return {"merge":[],"archive":[]}.`;

/** Parse the leading `---` YAML front-matter; tolerant of a missing/garbled block. */
function parseFront(text: string): { name?: string; description?: string; source?: string; version?: number; created?: string } {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  try {
    const data = parseYaml(match[1]) as Record<string, unknown> | null;
    const stem = ((data?.metadata as Record<string, unknown> | undefined)?.stem ?? {}) as Record<string, unknown>;
    return {
      name: typeof data?.name === 'string' ? data.name : undefined,
      description: typeof data?.description === 'string' ? data.description : undefined,
      source: typeof stem.source === 'string' ? stem.source : undefined,
      version: typeof stem.version === 'number' ? stem.version : undefined,
      created: typeof stem.created === 'string' ? stem.created : undefined
    };
  } catch {
    return {};
  }
}

/** Strip the leading front-matter block, returning just the body. */
function stripFront(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

/** Load only the agent-authored skills (never user/bundled ones). */
function loadAgentSkills(usage: SkillsUsage): AgentSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: AgentSkill[] = [];
  for (const slug of entries) {
    let raw: string;
    try {
      raw = readFileSync(join(skillsRoot(), slug, 'SKILL.md'), 'utf8');
    } catch {
      continue; // not a skill directory
    }
    const fm = parseFront(raw);
    if (fm.source !== 'agent') continue; // never touch user/bundled skills
    out.push({
      slug,
      name: fm.name ?? slug,
      description: fm.description ?? '',
      version: fm.version ?? 1,
      created: fm.created ?? new Date().toISOString(),
      body: stripFront(raw),
      useCount: usage.skills[slug]?.count ?? 0,
      lastUsedAt: usage.skills[slug]?.lastUsedAt
    });
  }
  return out;
}

/** "2026-07-23" from an ISO timestamp (the prompt doesn't need the time part). */
function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

function buildPrompt(skills: AgentSkill[], trackingSince: string): string {
  const header =
    `Today is ${isoDay(new Date().toISOString())}. Usage has been tracked since ${isoDay(trackingSince)} — ` +
    'a skill created before that date may have earlier uses that were never recorded.';
  const blocks = skills
    .map((s) => {
      const usage = s.useCount
        ? `used ${s.useCount}×, last ${isoDay(s.lastUsedAt ?? '')}`
        : 'never used since tracking began';
      return `## [${s.slug}] ${s.name}\n${s.description}\nCreated ${isoDay(s.created)} · ${usage}\n\n${s.body}`;
    })
    .join('\n\n---\n\n');
  return `${INSTRUCTIONS}\n\n${header}\n\nSkills:\n\n${blocks}`;
}

/** Parse the model's reply into curate ops. Defensive: any malformation → no-op. */
export function parseCurate(output: string): CurateOps {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return { ...EMPTY_OPS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { ...EMPTY_OPS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_OPS };
  const obj = parsed as Record<string, unknown>;

  const merge: CurateOps['merge'] = [];
  if (Array.isArray(obj.merge)) {
    for (const m of obj.merge) {
      if (!m || typeof m !== 'object') continue;
      const slugs = (m as { slugs?: unknown }).slugs;
      const description = (m as { description?: unknown }).description;
      const content = (m as { content?: unknown }).content;
      if (
        Array.isArray(slugs) &&
        slugs.every((s) => typeof s === 'string') &&
        slugs.length >= 2 &&
        typeof description === 'string' &&
        typeof content === 'string' &&
        content.trim()
      ) {
        // A merge never renames: the winner's slug IS its name, and a rename
        // would mean a new directory rather than a merge. Any `name` the model
        // sends is dropped here rather than silently half-applied.
        merge.push({ slugs: slugs as string[], description, content });
      }
    }
  }
  const archive: string[] = [];
  if (Array.isArray(obj.archive)) {
    for (const s of obj.archive) if (typeof s === 'string') archive.push(s);
  }
  return { merge, archive };
}

/**
 * Drop ops that name unknown slugs, then reject the whole batch if it would retire
 * (archive + merge losers) more than MAX_DROP_FRACTION of the set. `known` is the
 * set of agent-authored slugs the model is allowed to touch.
 */
export function clampCurate(ops: CurateOps, known: Set<string>, total: number): CurateOps {
  const merge = ops.merge
    .map((m) => ({ ...m, slugs: m.slugs.filter((s) => known.has(s)) }))
    .filter((m) => m.slugs.length >= 2);
  const archive = ops.archive.filter((s) => known.has(s));

  // Bound the model's blast radius, but always allow at least one retirement —
  // otherwise a tiny library (e.g. one duplicate pair) could never be deduped,
  // since merging 1 of 2 already exceeds the fraction.
  const mergeLosers = merge.reduce((n, m) => n + (m.slugs.length - 1), 0);
  const wouldRetire = archive.length + mergeLosers;
  const limit = Math.max(1, Math.floor(MAX_DROP_FRACTION * total));
  if (wouldRetire > limit) return { ...EMPTY_OPS };

  return { merge, archive };
}

/** Disable a skill (reversible) by writing the `.disabled` marker the app uses. */
function archiveSkill(slug: string): void {
  writeFileSync(join(skillsRoot(), slug, DISABLED_MARKER), 'archived by Stem curator\n', 'utf8');
}

function applyCurate(skills: AgentSkill[], ops: CurateOps): CurateResult {
  const bySlug = new Map(skills.map((s) => [s.slug, s]));
  let merged = 0;
  let archived = 0;

  for (const m of ops.merge) {
    const [winnerSlug, ...losers] = m.slugs;
    const winner = bySlug.get(winnerSlug);
    if (!winner) continue;
    // Through saveSkill, so a merged body meets the same contract as every other
    // write — and, more importantly, so a merge that would produce an invalid
    // skill writes nothing rather than half of one. Losers are only deleted once
    // the winner is safely on disk; the group is left for a later cycle otherwise.
    const written = saveSkill(
      { name: winnerSlug, description: m.description || winner.description, body: m.content },
      { expectExisting: true, origin: 'unknown' }
    );
    if (!written.ok) continue;
    try {
      for (const loser of losers) {
        if (loser === winnerSlug) continue;
        rmSync(join(skillsRoot(), loser), { recursive: true, force: true });
      }
    } catch {
      // best-effort; a loser left behind is a duplicate, not a broken library
    }
    // Proven utility survives the merge: winner inherits the losers' counts.
    mergeUsage(winnerSlug, losers);
    merged += 1;
  }

  for (const slug of ops.archive) {
    try {
      archiveSkill(slug);
      archived += 1;
    } catch {
      // best-effort
    }
  }

  // Republish the ignore file once for the whole batch — merges delete losers and
  // archives add markers, and both change what the backend should stop loading.
  if (merged || archived) syncSkillsIgnore();

  return { merged, archived };
}

/**
 * Run one curation pass over the agent-authored skills. Returns counts of what
 * changed (all zero when nothing ran or nothing needed changing). The caller
 * reloads the backend when any count is non-zero so pi picks up the new files.
 */
export async function curateSkills(llm: LlmClient, opts: { force?: boolean } = {}): Promise<CurateResult> {
  if (!isRecallEnabled()) return ZERO;
  const usage = readUsage();
  const skills = loadAgentSkills(usage);
  // The automatic pass skips small sets; a manual trigger still needs two to merge.
  if (skills.length < (opts.force ? 2 : MIN_SKILLS)) return ZERO;

  const prompt = buildPrompt(skills, usage.trackingSince);
  if (prompt.length > MAX_PROMPT_CHARS) {
    console.warn(`[skills curator] ${skills.length} skills exceed the single-pass budget; skipping.`);
    return ZERO;
  }

  let ops: CurateOps;
  try {
    ops = parseCurate(await llm.complete(prompt));
  } catch {
    return ZERO; // model error — retry next cycle
  }

  const known = new Set(skills.map((s) => s.slug));
  const result = applyCurate(skills, clampCurate(ops, known, skills.length));
  // Hygiene: drop usage entries for skills deleted by merges above — and for
  // dirs removed out-of-band (manage_skill "remove" runs in the bridge
  // subprocess, which cannot touch the sidecar itself).
  pruneUsage();
  return result;
}
