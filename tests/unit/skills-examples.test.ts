// Example requests per skill: the sidecar, the writer pass, and how selection
// scores a skill against its examples (best of description and examples, own
// floor). Throwaway skills dir and fake clients, as in skills-inject.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-examples-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import {
  SKILLS_EXAMPLES_FILE,
  SKILL_EXAMPLES_VERSION,
  examplesPrompt,
  parseExamples,
  readSkillExamples,
  refreshSkillExamples
} from '../../src/server/skills/examples';
import { SKILLS_EXAMPLE_VECTORS_FILE } from '../../src/server/skills/vectors';
import { selectSkills, type SkillRecordish } from '../../src/server/skills/inject';

const examplesFile = join(skillsDir, SKILLS_EXAMPLES_FILE);
const QUERY = 'pozri posledný mail od ikea prosím';

function skill(slug: string, over: Partial<SkillRecordish> = {}): SkillRecordish {
  return { slug, name: slug, description: `Use when ${slug}`, body: `## Steps\n1. run ${slug}\n`, origin: 'assistant', ...over };
}

/** Query embeds to [1,0]; a passage gets the cosine listed under its full text, else 0. */
function fakeEmbeddings(cosines: Record<string, number>) {
  const passages: string[] = [];
  const unit = (c: number) => Float32Array.from([c, Math.sqrt(Math.max(0, 1 - c * c))]);
  return {
    passages,
    client: {
      available: async () => true,
      modelId: async () => 'fake-embed-v1',
      embed: async (texts: string[], kind?: string) => {
        if (kind === 'query') return texts.map(() => Float32Array.from([1, 0]));
        passages.push(...texts);
        return texts.map((t) => unit(cosines[t] ?? cosines[t.split('\n')[0]] ?? 0));
      }
    }
  };
}

/** Cross-encoder keyed by the FULL document, so description and example pairs score apart. */
function fakeRerank(scores: Record<string, number>, opts: { floor?: number; exampleFloor?: number | null } = {}) {
  const docs: string[] = [];
  return {
    docs,
    client: {
      available: async () => true,
      minRelevantScore: async () => opts.floor ?? -4,
      ...(opts.exampleFloor === null ? {} : { skillExampleFloor: async () => opts.exampleFloor ?? 3 }),
      rerank: async (_q: string, list: string[]) => {
        docs.push(...list);
        return list.map((doc, index) => ({ index, score: scores[doc] ?? -11 }));
      }
    }
  };
}

function writeStored(skills: Record<string, { hash: string; examples: string[] }>) {
  writeFileSync(examplesFile, JSON.stringify({ version: SKILL_EXAMPLES_VERSION, skills }));
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('selection with example requests', () => {
  const mail = skill('find-latest-mail', { description: 'Use when finding the latest email from a brand.' });
  const other = skill('reconcile-bank');
  const examples = new Map([['find-latest-mail', ['najdi posledny mail od IKEA', 'Find the newest email from Lufthansa']]]);

  it('loads a skill whose example matches though its description scores below the floor', async () => {
    const { client } = fakeEmbeddings({ 'find-latest-mail': 0.5, 'reconcile-bank': 0.4 });
    const rr = fakeRerank({
      'find-latest-mail\nUse when finding the latest email from a brand.': -6,
      'find-latest-mail\nnajdi posledny mail od IKEA': 5
    });
    const sel = await selectSkills(QUERY, [mail, other], { embeddings: client, rerank: rr.client, examples });
    expect(sel.inlined.map((s) => s.slug)).toEqual(['find-latest-mail']);
    // Description plus each example, one pair per call.
    expect(rr.docs.filter((d) => d.startsWith('find-latest-mail\n'))).toHaveLength(3);
  });

  it('holds a best-of score to the example floor, not the description floor', async () => {
    const { client } = fakeEmbeddings({ 'find-latest-mail': 0.5 });
    // 2 clears the description floor (-4) by a mile but not the example floor (3).
    const rr = fakeRerank({ 'find-latest-mail\nnajdi posledny mail od IKEA': 2 });
    const sel = await selectSkills(QUERY, [mail, other], { embeddings: client, rerank: rr.client, examples });
    expect(sel.inlined).toEqual([]);
  });

  it('keeps the description floor for a skill still waiting for examples', async () => {
    const { client } = fakeEmbeddings({ 'find-latest-mail': 0.5, 'reconcile-bank': 0.6 });
    const rr = fakeRerank({ 'reconcile-bank\nUse when reconcile-bank': -3 });
    const sel = await selectSkills(QUERY, [mail, other], { embeddings: client, rerank: rr.client, examples });
    expect(sel.inlined.map((s) => s.slug)).toEqual(['reconcile-bank']);
  });

  it('orders skills by their margin over their own floor', async () => {
    const { client } = fakeEmbeddings({ 'find-latest-mail': 0.5, 'reconcile-bank': 0.6 });
    const rr = fakeRerank({
      'find-latest-mail\nnajdi posledny mail od IKEA': 4, // 1 over the example floor
      'reconcile-bank\nUse when reconcile-bank': -1 // 3 over the description floor
    });
    const sel = await selectSkills(QUERY, [mail, other], { embeddings: client, rerank: rr.client, examples, maxInlined: 1 });
    expect(sel.inlined.map((s) => s.slug)).toEqual(['reconcile-bank']);
  });

  it('lets an example pull a skill into the shortlist', async () => {
    const lib = [mail, ...['a', 'b', 'c', 'd'].map((x) => skill(x))];
    const { client } = fakeEmbeddings({ a: 0.6, b: 0.6, c: 0.6, d: 0.6, 'find-latest-mail': 0.1, 'najdi posledny mail od IKEA': 0.9 });
    const rr = fakeRerank({ 'find-latest-mail\nnajdi posledny mail od IKEA': 5 });
    const sel = await selectSkills(QUERY, lib, { embeddings: client, rerank: rr.client, examples });
    expect(sel.inlined.map((s) => s.slug)).toEqual(['find-latest-mail']);
    expect(existsSync(join(skillsDir, SKILLS_EXAMPLE_VECTORS_FILE))).toBe(true);
  });

  it('ignores examples with a reranker that has no example floor', async () => {
    const { client, passages } = fakeEmbeddings({ 'find-latest-mail': 0.5 });
    const rr = fakeRerank({ 'find-latest-mail\nnajdi posledny mail od IKEA': 9 }, { exampleFloor: null });
    const sel = await selectSkills(QUERY, [mail, other], { embeddings: client, rerank: rr.client, examples });
    expect(sel.inlined).toEqual([]);
    expect(rr.docs.some((d) => d.includes('IKEA'))).toBe(false);
    expect(passages.some((p) => p.includes('IKEA'))).toBe(false);
  });

  it('reads examples from the sidecar when the caller passes none', async () => {
    await refreshSkillExamples({ complete: async () => JSON.stringify({ 'find-latest-mail': ['najdi posledny mail od IKEA', 'kde je mail od Wolt'] }) }, [mail]);
    const { client } = fakeEmbeddings({ 'find-latest-mail': 0.5 });
    const rr = fakeRerank({ 'find-latest-mail\nnajdi posledny mail od IKEA': 5 });
    const sel = await selectSkills(QUERY, [mail], { embeddings: client, rerank: rr.client });
    expect(sel.inlined.map((s) => s.slug)).toEqual(['find-latest-mail']);
  });
});

describe('example sidecar and writer', () => {
  const a = skill('alpha');
  const b = skill('beta');

  it('writes examples only for skills that lack them, and keeps the rest', async () => {
    const llm = { complete: vi.fn(async () => JSON.stringify({ alpha: ['one two three', 'four five six', 'seven'], beta: ['x y z', 'q r s'] })) };
    expect(await refreshSkillExamples(llm, [a, b])).toEqual({ written: 2, missing: 0 });
    expect(readSkillExamples([a, b]).get('alpha')).toEqual(['one two three', 'four five six', 'seven']);
    llm.complete.mockClear();
    expect(await refreshSkillExamples(llm, [a, b])).toEqual({ written: 0, missing: 0 });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('retires examples when the description changes', async () => {
    await refreshSkillExamples({ complete: async () => JSON.stringify({ alpha: ['one two', 'three four'] }) }, [a]);
    const edited = { ...a, description: 'Use when something else entirely' };
    expect(readSkillExamples([edited]).size).toBe(0);
  });

  it('drops entries for deleted skills', async () => {
    await refreshSkillExamples({ complete: async () => JSON.stringify({ alpha: ['one two', 'three four'], beta: ['five six', 'seven eight'] }) }, [a, b]);
    await refreshSkillExamples({ complete: async () => '{}' }, [a]);
    const stored = JSON.parse(readFileSync(examplesFile, 'utf8'));
    expect(Object.keys(stored.skills)).toEqual(['alpha']);
  });

  it('survives a failed or unusable reply and leaves the skills for next time', async () => {
    expect(await refreshSkillExamples({ complete: async () => { throw new Error('down'); } }, [a])).toEqual({ written: 0, missing: 1 });
    expect(await refreshSkillExamples({ complete: async () => 'no json here' }, [a])).toEqual({ written: 0, missing: 1 });
    expect(existsSync(examplesFile)).toBe(false);
  });

  it('ignores a corrupt or wrong-version file', () => {
    writeFileSync(examplesFile, '{nope');
    expect(readSkillExamples([a]).size).toBe(0);
    writeFileSync(examplesFile, JSON.stringify({ version: 999, skills: {} }));
    expect(readSkillExamples([a]).size).toBe(0);
    writeStored({ alpha: { hash: 'stale', examples: ['one two', 'three four'] } });
    expect(readSkillExamples([a]).size).toBe(0);
  });
});

describe('parseExamples', () => {
  it('cleans, dedupes and caps, and drops skills with too few usable examples', () => {
    const out = parseExamples(
      'Here you go: {"alpha": ["  one   two ", "ONE TWO", "x", "three four", "five six", "seven eight", 3], "beta": ["only one"], "gamma": ["a b", "c d"]}',
      ['alpha', 'beta']
    );
    expect(out.get('alpha')).toEqual(['one two', 'three four', 'five six', 'seven eight']);
    expect(out.has('beta')).toBe(false);
    expect(out.has('gamma')).toBe(false);
  });
});

describe('examplesPrompt', () => {
  it('asks for the user\'s languages when the profile says how they write, English otherwise', () => {
    const withStyle = examplesPrompt([skill('alpha')], 'Writes mostly in Slovak, sometimes English.');
    expect(withStyle).toContain('Writes mostly in Slovak');
    expect(withStyle).toContain('at least one in English');
    expect(examplesPrompt([skill('alpha')], null)).toContain('Write the examples in English.');
  });
});
