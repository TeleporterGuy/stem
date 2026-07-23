import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillsRoot } from '../workspace/paths';

// Per-skill usage bookkeeping, kept in a sidecar JSON at the root of the skills
// dir (next to `.skills-rev` — pi's skill scanner only looks at directories with
// a SKILL.md, so top-level files are invisible to it). Deliberately NOT stored in
// SKILL.md front-matter: any SKILL.md write bumps `.skills-rev` and forces a
// backend reload, which a mere usage tick must never do. The Electron main
// process is the sole writer; the bridge subprocess never touches this file.
//
// Usage is advisory data for the Manage panel and the curator prompt — losing it
// (corrupt file, manual delete) costs nothing but history, so the reader is
// tolerant and simply starts over.

export const SKILLS_USAGE_FILE = '.skills-usage.json';

export interface SkillUsageEntry {
  count: number;
  lastUsedAt: string; // ISO
}

export interface SkillsUsage {
  /** When tracking first ran here — a zero count only means "never since this". */
  trackingSince: string; // ISO
  skills: Record<string, SkillUsageEntry>;
}

function usageFile(): string {
  return join(skillsRoot(), SKILLS_USAGE_FILE);
}

function freshUsage(): SkillsUsage {
  return { trackingSince: new Date().toISOString(), skills: {} };
}

/** Tolerant read: a missing or corrupt file yields a fresh in-memory value
 *  (without writing — the next real write persists it). */
export function readUsage(): SkillsUsage {
  let raw: string;
  try {
    raw = readFileSync(usageFile(), 'utf8');
  } catch {
    return freshUsage();
  }
  try {
    const data = JSON.parse(raw) as Partial<SkillsUsage> | null;
    if (!data || typeof data.trackingSince !== 'string') return freshUsage();
    const skills: Record<string, SkillUsageEntry> = {};
    for (const [slug, entry] of Object.entries(data.skills ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      const { count, lastUsedAt } = entry as Partial<SkillUsageEntry>;
      if (typeof count === 'number' && Number.isInteger(count) && count > 0 && typeof lastUsedAt === 'string') {
        skills[slug] = { count, lastUsedAt };
      }
    }
    return { trackingSince: data.trackingSince, skills };
  } catch {
    return freshUsage();
  }
}

function writeUsage(usage: SkillsUsage): void {
  try {
    writeFileSync(usageFile(), `${JSON.stringify(usage, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort: usage is advisory; drop the tick rather than fail a turn
  }
}

/** True when `slug` names a real skill directory (has a SKILL.md). */
function isSkillSlug(slug: string): boolean {
  return existsSync(join(skillsRoot(), slug, 'SKILL.md'));
}

/**
 * Anchor `trackingSince` by creating the sidecar if absent (never resets an
 * existing one) and drop entries for since-deleted skills. Called at startup.
 */
export function ensureUsageTracking(): void {
  try {
    mkdirSync(skillsRoot(), { recursive: true });
  } catch {
    return;
  }
  if (!existsSync(usageFile())) writeUsage(freshUsage());
  pruneUsage();
}

/**
 * Count one use of each slug (callers dedupe per turn). Slugs without a SKILL.md
 * are ignored — this is the backstop that keeps top-level files (`.skills-rev`)
 * and stray directories out of the ledger. Returns how many slugs were counted;
 * writes only when non-zero.
 */
export function recordUses(slugs: string[], at: Date = new Date()): number {
  const real = slugs.filter(isSkillSlug);
  if (real.length === 0) return 0;
  const usage = readUsage();
  const iso = at.toISOString();
  for (const slug of real) {
    const entry = usage.skills[slug];
    usage.skills[slug] = { count: (entry?.count ?? 0) + 1, lastUsedAt: iso };
  }
  writeUsage(usage);
  return real.length;
}

/**
 * Fold merge losers' usage into the winner (summed count, latest lastUsedAt) so
 * proven utility survives curator merges. No-op when nothing was tracked.
 */
export function mergeUsage(winner: string, losers: string[]): void {
  const usage = readUsage();
  const tracked = losers.filter((slug) => slug !== winner && usage.skills[slug]);
  if (tracked.length === 0) return;
  let count = usage.skills[winner]?.count ?? 0;
  let lastUsedAt = usage.skills[winner]?.lastUsedAt ?? '';
  for (const slug of tracked) {
    const entry = usage.skills[slug];
    count += entry.count;
    if (entry.lastUsedAt > lastUsedAt) lastUsedAt = entry.lastUsedAt;
    delete usage.skills[slug];
  }
  usage.skills[winner] = { count, lastUsedAt };
  writeUsage(usage);
}

/** Drop entries whose skill directory is gone (manage_skill remove, merges). */
export function pruneUsage(): void {
  const usage = readUsage();
  const stale = Object.keys(usage.skills).filter((slug) => !isSkillSlug(slug));
  if (stale.length === 0) return;
  for (const slug of stale) delete usage.skills[slug];
  writeUsage(usage);
}
