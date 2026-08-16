// Skills curator regression suite. Exercises the pure parse/clamp helpers and the
// real curateSkills() against a throwaway skills dir (STEM_SKILLS_DIR), with a
// fake LlmClient so no backend is needed — mirroring the recall probe style.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { clampCurate, curateSkills, parseCurate } from '../../src/server/skills/curate';
import { readUsage, recordUses } from '../../src/server/skills/usage';
import type { LlmClient } from '../../src/server/recall/llm';

function fakeLlm(reply: string): LlmClient {
  return { complete: async () => reply };
}

// A merged body is written through saveSkill now, so it has to meet the same
// contract as every other write — the curator is no longer a back door around it.
const MERGED_BODY = `## When to use
When the user asks for coffee.

## Steps
1. Boil water.
2. Pour it over the grounds.

## Verification
The cup is full and the kettle is empty.`;

function writeSkill(slug: string, opts: { source?: 'agent' | 'user'; version?: number; body?: string }): void {
  const src = opts.source ?? 'agent';
  const fm = [
    '---',
    `name: ${JSON.stringify(slug)}`,
    `description: ${JSON.stringify(`does ${slug}`)}`,
    'metadata:',
    '  stem:',
    `    source: ${src}`,
    `    version: ${opts.version ?? 1}`,
    '    created: "2026-01-01T00:00:00.000Z"',
    '    updated: "2026-01-01T00:00:00.000Z"',
    '---'
  ].join('\n');
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(join(skillsDir, slug, 'SKILL.md'), `${fm}\n\n${opts.body ?? `Step 1 for ${slug}.`}\n`, 'utf8');
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('parseCurate', () => {
  it('parses merge/archive and tolerates fences/prose', () => {
    const ops = parseCurate('here you go:\n{"merge":[{"slugs":["a","b"],"description":"d","content":"x"}],"archive":["d"]}');
    expect(ops.merge).toHaveLength(1);
    expect(ops.merge[0].slugs).toEqual(['a', 'b']);
    expect(ops.archive).toEqual(['d']);
  });

  it('ignores a patch op, which the curator no longer performs', () => {
    // Body edits moved to the assistant, which fixes a skill when it uses one and
    // finds it wrong — the only moment there is evidence of what is actually
    // broken. A model still emitting the retired op must not be obeyed.
    const ops = parseCurate('{"merge":[],"patch":[{"slug":"c","content":"rewritten"}],"archive":[]}');
    expect(ops).toEqual({ merge: [], archive: [] });
  });

  it('drops malformed ops (merge needs >=2 slugs, content non-empty)', () => {
    const ops = parseCurate('{"merge":[{"slugs":["a"],"description":"d","content":"x"}],"archive":[1]}');
    expect(ops.merge).toHaveLength(0);
    expect(ops.archive).toHaveLength(0);
  });

  it('returns empty ops on non-JSON', () => {
    expect(parseCurate('no json here')).toEqual({ merge: [], archive: [] });
  });
});

describe('clampCurate', () => {
  it('drops ops naming unknown slugs', () => {
    const known = new Set(['a', 'b']);
    const ops = clampCurate(
      { merge: [{ slugs: ['a', 'zzz'], description: 'd', content: 'x' }], archive: ['b', 'ghost'] },
      known,
      4
    );
    expect(ops.merge).toHaveLength(0); // 'a' alone after filtering 'zzz' → <2 slugs
    expect(ops.archive).toEqual(['b']);
  });

  it('rejects a batch that would retire more than 40% of the set', () => {
    const known = new Set(['a', 'b', 'c', 'd', 'e']);
    const ops = clampCurate({ merge: [], archive: ['a', 'b', 'c'] }, known, 5); // 3/5 = 60%
    expect(ops).toEqual({ merge: [], archive: [] });
  });
});

describe('curateSkills', () => {
  it('merges duplicate agent skills and never touches user skills', async () => {
    writeSkill('make-coffee', { source: 'agent' });
    writeSkill('brew-coffee', { source: 'agent' });
    writeSkill('user-thing', { source: 'user' });

    const llm = fakeLlm(
      JSON.stringify({
        merge: [{ slugs: ['make-coffee', 'brew-coffee'], description: 'Brew a pot when the user asks for coffee.', content: MERGED_BODY }],
        archive: []
      })
    );
    const res = await curateSkills(llm, { force: true });
    expect(res.merged).toBe(1);
    expect(existsSync(join(skillsDir, 'make-coffee', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'brew-coffee'))).toBe(false); // loser removed
    expect(existsSync(join(skillsDir, 'user-thing', 'SKILL.md'))).toBe(true); // untouched
    const winner = readFileSync(join(skillsDir, 'make-coffee', 'SKILL.md'), 'utf8');
    expect(winner).toContain('Boil water');
    expect(winner).toMatch(/version:\s*2/); // bumped
  });

  it('archives a stale skill with the .disabled marker (reversible)', async () => {
    writeSkill('old-way', { source: 'agent' });
    writeSkill('keep-a', { source: 'agent' });
    writeSkill('keep-b', { source: 'agent' });

    const llm = fakeLlm(JSON.stringify({ merge: [], archive: ['old-way'] }));
    const res = await curateSkills(llm, { force: true });
    expect(res.archived).toBe(1);
    expect(existsSync(join(skillsDir, 'old-way', '.disabled'))).toBe(true);
    expect(existsSync(join(skillsDir, 'old-way', 'SKILL.md'))).toBe(true); // not deleted
    // ...and it actually leaves the prompt: the marker alone is invisible to the
    // backend, so the archive has to reach the ignore file too.
    const ignore = readFileSync(join(skillsDir, '.gitignore'), 'utf8');
    expect(ignore).toContain('old-way/');
    expect(ignore).not.toContain('keep-a/');
  });

  it('feeds usage stats into the prompt (tracked, never-used, tracking-since header)', async () => {
    writeSkill('used-one', { source: 'agent' });
    writeSkill('dusty-one', { source: 'agent' });
    recordUses(['used-one'], new Date('2026-07-10T00:00:00.000Z'));
    recordUses(['used-one'], new Date('2026-07-15T00:00:00.000Z'));

    let seen = '';
    const llm: LlmClient = {
      complete: async (prompt: string) => {
        seen = prompt;
        return '{"merge":[],"archive":[]}';
      }
    };
    await curateSkills(llm, { force: true });
    // Drift guard on the split posture (SKILLS-UPKEEP.md, "Defect 2"): the merge
    // list is an umbrella pass, and DEFAULT TO KEEP governs archive ONLY. The
    // previous prompt let one cautious posture govern both, and archived nothing
    // for the library's whole recorded history.
    expect(seen).toContain('ONE skill with N labeled subsections');
    expect(seen).toContain('archive — DEFAULT TO KEEP');
    expect(seen).toContain('Usage has been tracked since');
    expect(seen).toContain('used 2×, last 2026-07-15');
    expect(seen).toContain('never used since tracking began');
    expect(seen).toContain('Created 2026-01-01');
  });

  it('merge folds the losers\' usage into the winner and prunes their entries', async () => {
    writeSkill('make-coffee', { source: 'agent' });
    writeSkill('brew-coffee', { source: 'agent' });
    recordUses(['make-coffee'], new Date('2026-06-01T00:00:00.000Z'));
    recordUses(['brew-coffee'], new Date('2026-07-01T00:00:00.000Z'));

    const llm = fakeLlm(
      JSON.stringify({
        merge: [{ slugs: ['make-coffee', 'brew-coffee'], description: 'Brew a pot when the user asks for coffee.', content: MERGED_BODY }],
        archive: []
      })
    );
    const res = await curateSkills(llm, { force: true });
    expect(res.merged).toBe(1);
    const usage = readUsage();
    expect(usage.skills['make-coffee']).toEqual({ count: 2, lastUsedAt: '2026-07-01T00:00:00.000Z' });
    expect(usage.skills['brew-coffee']).toBeUndefined();
  });

  it('does not call the model when there are fewer than two agent skills', async () => {
    writeSkill('lonely', { source: 'agent' });
    writeSkill('a-user-skill', { source: 'user' });
    let called = false;
    const llm: LlmClient = {
      complete: async () => {
        called = true;
        return '{}';
      }
    };
    const res = await curateSkills(llm, { force: true });
    expect(called).toBe(false);
    expect(res).toEqual({ merged: 0, archived: 0 });
  });
});
