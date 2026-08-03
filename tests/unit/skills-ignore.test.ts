// Turning a skill off used to be cosmetic: `.disabled` is a Stem invention the
// agent backend has never heard of, and its scanner stops at the first SKILL.md
// in a directory, so it never sees the marker. The only exclusion it honours is
// an ignore file. These cases pin the projection from one to the other, including
// the exact line syntax the scanner matches (`<slug>/`, tested per directory
// entry against a root-level .gitignore).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-ignore-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { SKILLS_IGNORE_FILE, disabledSlugs, syncSkillsIgnore } from '../../src/main/skills/ignore';
import { listSkills, setSkillEnabled } from '../../src/main/workspace/skills';

const ignoreFile = join(skillsDir, SKILLS_IGNORE_FILE);

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

describe('setSkillEnabled', () => {
  it('hides a disabled skill from the backend and reveals it again', async () => {
    writeSkill('brew-coffee');
    writeSkill('keep-me');

    await setSkillEnabled('brew-coffee', false);
    expect(readFileSync(ignoreFile, 'utf8')).toContain('brew-coffee/');
    expect(readFileSync(ignoreFile, 'utf8')).not.toContain('keep-me/');

    await setSkillEnabled('brew-coffee', true);
    // Nothing disabled means nothing to hide — the file goes away rather than
    // lingering with stale entries.
    expect(existsSync(ignoreFile)).toBe(false);
  });

  it('keeps the marker as the source of truth the panel reads', async () => {
    writeSkill('brew-coffee');
    const skills = await setSkillEnabled('brew-coffee', false);
    expect(skills.find((s) => s.slug === 'brew-coffee')?.enabled).toBe(false);
    expect(existsSync(join(skillsDir, 'brew-coffee', '.disabled'))).toBe(true);
  });

  it('does not count the ignore file as a skill', async () => {
    writeSkill('brew-coffee');
    await setSkillEnabled('brew-coffee', false);
    expect((await listSkills()).map((s) => s.slug)).toEqual(['brew-coffee']);
  });
});

describe('syncSkillsIgnore', () => {
  it('rebuilds from the markers rather than appending', () => {
    writeSkill('a');
    writeSkill('b');
    writeFileSync(join(skillsDir, 'a', '.disabled'), 'x', 'utf8');
    writeFileSync(ignoreFile, 'garbage-from-somewhere/\n', 'utf8');

    expect(syncSkillsIgnore()).toEqual(['a']);
    const text = readFileSync(ignoreFile, 'utf8');
    expect(text).toContain('a/');
    expect(text).not.toContain('garbage-from-somewhere/');
  });

  it('lists disabled slugs in a stable order', () => {
    for (const slug of ['zulu', 'alpha', 'mike']) {
      writeSkill(slug);
      writeFileSync(join(skillsDir, slug, '.disabled'), 'x', 'utf8');
    }
    expect(disabledSlugs()).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('survives a missing skills directory', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    expect(syncSkillsIgnore()).toEqual([]);
  });
});
