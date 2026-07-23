// Skill usage sidecar regression suite: the `.skills-usage.json` ledger that
// records how often the assistant consults each skill, plus its join into
// listSkills(). Uses a throwaway skills dir (STEM_SKILLS_DIR), mirroring
// skills-curate.test.ts.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-usage-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import {
  SKILLS_USAGE_FILE,
  ensureUsageTracking,
  mergeUsage,
  pruneUsage,
  readUsage,
  recordUses
} from '../../src/main/skills/usage';
import { listSkills } from '../../src/main/workspace/skills';

const usageFile = join(skillsDir, SKILLS_USAGE_FILE);

function writeSkill(slug: string): void {
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(
    join(skillsDir, slug, 'SKILL.md'),
    `---\nname: ${JSON.stringify(slug)}\ndescription: "does ${slug}"\n---\n\nStep 1.\n`,
    'utf8'
  );
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('ensureUsageTracking', () => {
  it('creates the sidecar once and never resets trackingSince', () => {
    ensureUsageTracking();
    expect(existsSync(usageFile)).toBe(true);
    const first = readUsage().trackingSince;
    ensureUsageTracking();
    expect(readUsage().trackingSince).toBe(first);
  });

  it('prunes stale entries while preserving live ones', () => {
    writeSkill('alive');
    writeSkill('doomed');
    recordUses(['alive', 'doomed']);
    rmSync(join(skillsDir, 'doomed'), { recursive: true, force: true });
    ensureUsageTracking();
    const usage = readUsage();
    expect(usage.skills.alive?.count).toBe(1);
    expect(usage.skills.doomed).toBeUndefined();
  });
});

describe('readUsage', () => {
  it('yields a fresh value for a missing file without writing it', () => {
    const usage = readUsage();
    expect(usage.skills).toEqual({});
    expect(existsSync(usageFile)).toBe(false);
  });

  it('tolerates a corrupt file and garbage entries', () => {
    writeFileSync(usageFile, 'not json', 'utf8');
    expect(readUsage().skills).toEqual({});
    writeFileSync(
      usageFile,
      JSON.stringify({
        trackingSince: '2026-01-01T00:00:00.000Z',
        skills: { ok: { count: 2, lastUsedAt: '2026-06-01T00:00:00.000Z' }, bad: { count: 'x' }, worse: null }
      }),
      'utf8'
    );
    const usage = readUsage();
    expect(usage.trackingSince).toBe('2026-01-01T00:00:00.000Z');
    expect(Object.keys(usage.skills)).toEqual(['ok']);
  });
});

describe('recordUses', () => {
  it('counts only real skills, increments, and stamps lastUsedAt', () => {
    writeSkill('brew-coffee');
    const first = new Date('2026-07-01T10:00:00.000Z');
    const second = new Date('2026-07-02T10:00:00.000Z');
    expect(recordUses(['brew-coffee', '.skills-rev', 'ghost'], first)).toBe(1);
    expect(recordUses(['brew-coffee'], second)).toBe(1);
    const entry = readUsage().skills['brew-coffee'];
    expect(entry).toEqual({ count: 2, lastUsedAt: second.toISOString() });
  });

  it('does not write when no slug is a real skill', () => {
    expect(recordUses(['ghost'])).toBe(0);
    expect(existsSync(usageFile)).toBe(false);
  });
});

describe('mergeUsage', () => {
  it('sums counts, keeps the latest lastUsedAt, and removes losers', () => {
    writeSkill('winner');
    writeSkill('loser-a');
    writeSkill('loser-b');
    recordUses(['winner'], new Date('2026-05-01T00:00:00.000Z'));
    recordUses(['loser-a'], new Date('2026-06-01T00:00:00.000Z'));
    recordUses(['loser-a'], new Date('2026-06-02T00:00:00.000Z'));
    mergeUsage('winner', ['loser-a', 'loser-b']);
    const usage = readUsage();
    expect(usage.skills.winner).toEqual({ count: 3, lastUsedAt: '2026-06-02T00:00:00.000Z' });
    expect(usage.skills['loser-a']).toBeUndefined();
  });

  it('is a no-op when no loser was ever tracked', () => {
    mergeUsage('winner', ['loser']);
    expect(existsSync(usageFile)).toBe(false);
  });
});

describe('pruneUsage', () => {
  it('drops entries whose skill dir is gone', () => {
    writeSkill('keep');
    writeSkill('drop');
    recordUses(['keep', 'drop']);
    rmSync(join(skillsDir, 'drop'), { recursive: true, force: true });
    pruneUsage();
    const usage = readUsage();
    expect(usage.skills.keep?.count).toBe(1);
    expect(usage.skills.drop).toBeUndefined();
    // Sanity: the sidecar file itself must never look like a skill entry.
    expect(readFileSync(usageFile, 'utf8')).not.toContain(SKILLS_USAGE_FILE);
  });
});

describe('listSkills join', () => {
  it('exposes useCount/lastUsedAt on summaries, with explicit 0 when untracked', async () => {
    writeSkill('tracked');
    writeSkill('untracked');
    recordUses(['tracked'], new Date('2026-07-10T00:00:00.000Z'));
    const skills = await listSkills();
    const tracked = skills.find((s) => s.slug === 'tracked');
    const untracked = skills.find((s) => s.slug === 'untracked');
    expect(tracked?.useCount).toBe(1);
    expect(tracked?.lastUsedAt).toBe('2026-07-10T00:00:00.000Z');
    expect(untracked?.useCount).toBe(0);
    expect(untracked?.lastUsedAt).toBeUndefined();
  });
});
