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
  recordGrades,
  recordInjections,
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

  it('keeps an entry that has only ever been injected', () => {
    // Zero uses against many injections is not an empty record — it is the
    // denominator of a skill nobody follows, and dropping it as uninteresting
    // would erase the one signal that demotes it.
    writeFileSync(
      usageFile,
      JSON.stringify({
        trackingSince: '2026-01-01T00:00:00.000Z',
        skills: { ignored: { injected: 9, used: 0, lastGradedAt: 1_760_000_000 } }
      }),
      'utf8'
    );
    expect(readUsage().skills.ignored).toEqual({
      count: 0,
      lastUsedAt: '',
      injected: 9,
      used: 0,
      lastGradedAt: 1_760_000_000
    });
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

describe('recordInjections', () => {
  it('accumulates the denominator without touching the use count', () => {
    writeSkill('brew-coffee');
    expect(recordInjections(['brew-coffee'])).toBe(1);
    recordInjections(['brew-coffee']);
    expect(readUsage().skills['brew-coffee']).toEqual({ count: 0, lastUsedAt: '', injected: 2 });
  });

  it('leaves an existing consult count alone', () => {
    writeSkill('brew-coffee');
    recordUses(['brew-coffee'], new Date('2026-07-01T10:00:00.000Z'));
    recordInjections(['brew-coffee']);
    expect(readUsage().skills['brew-coffee']).toEqual({
      count: 1,
      lastUsedAt: '2026-07-01T10:00:00.000Z',
      injected: 1
    });
  });

  it('ignores slugs with no SKILL.md and writes nothing when none are real', () => {
    writeSkill('brew-coffee');
    expect(recordInjections(['brew-coffee', '.skills-rev', 'ghost'])).toBe(1);
    expect(Object.keys(readUsage().skills)).toEqual(['brew-coffee']);
    rmSync(usageFile, { force: true });
    expect(recordInjections(['ghost'])).toBe(0);
    expect(existsSync(usageFile)).toBe(false);
  });
});

describe('recordGrades', () => {
  it('bumps the numerator only for the skills the turn followed', () => {
    writeSkill('followed');
    writeSkill('ignored');
    recordInjections(['followed', 'ignored']);
    recordGrades(['followed', 'ignored'], ['followed'], new Date('2026-07-01T10:00:00.000Z'));
    const usage = readUsage();
    expect(usage.skills.followed?.used).toBe(1);
    expect(usage.skills.ignored?.used).toBe(0);
  });

  it('moves the decay anchor for every injected skill, hit or miss', () => {
    // Without this, a demoted skill's penalty decays back to neutral on the
    // strength of nothing having happened — the miss has to be an observation,
    // not an absence of one.
    writeSkill('followed');
    writeSkill('ignored');
    recordInjections(['followed', 'ignored']);
    const at = new Date('2026-07-01T10:00:00.000Z');
    recordGrades(['followed', 'ignored'], ['followed'], at);
    const seconds = Math.floor(at.getTime() / 1000);
    expect(readUsage().skills.followed?.lastGradedAt).toBe(seconds);
    expect(readUsage().skills.ignored?.lastGradedAt).toBe(seconds);
  });

  it('accumulates across turns', () => {
    writeSkill('brew-coffee');
    recordInjections(['brew-coffee']);
    recordGrades(['brew-coffee'], ['brew-coffee'], new Date('2026-07-01T10:00:00.000Z'));
    recordInjections(['brew-coffee']);
    recordGrades(['brew-coffee'], [], new Date('2026-07-02T10:00:00.000Z'));
    expect(readUsage().skills['brew-coffee']).toMatchObject({ injected: 2, used: 1 });
  });

  it('ignores slugs with no SKILL.md, even when graded as used', () => {
    // A skill can be removed or merged between the injection and the grade, and a
    // ledger entry for a directory that is gone would resurrect the slug in the
    // curator prompt.
    writeSkill('brew-coffee');
    recordInjections(['brew-coffee']);
    recordGrades(['brew-coffee', 'ghost'], ['brew-coffee', 'ghost'], new Date('2026-07-01T10:00:00.000Z'));
    expect(Object.keys(readUsage().skills)).toEqual(['brew-coffee']);
  });

  it('does not write when nothing injected was a real skill', () => {
    recordGrades(['ghost'], ['ghost']);
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

  it('sums the loop counters and keeps the latest grade anchor', () => {
    // A merge must not cost the winner its evidence: the loser's injections are
    // what its description earned, and losing them would let a proven skill look
    // brand new to the ranking blend.
    writeSkill('winner');
    writeSkill('loser');
    recordInjections(['winner', 'loser']);
    recordGrades(['winner'], ['winner'], new Date('2026-06-01T00:00:00.000Z'));
    recordGrades(['loser'], ['loser'], new Date('2026-06-05T00:00:00.000Z'));
    mergeUsage('winner', ['loser']);
    expect(readUsage().skills.winner).toMatchObject({
      injected: 2,
      used: 2,
      lastGradedAt: Math.floor(new Date('2026-06-05T00:00:00.000Z').getTime() / 1000)
    });
    expect(readUsage().skills.loser).toBeUndefined();
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
