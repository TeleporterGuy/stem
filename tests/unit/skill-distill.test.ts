// Skill distiller regression suite. Exercises the pure parse helpers and the real
// distillSkillsFromMessages() against a throwaway skills dir (STEM_SKILLS_DIR) and
// the shared throwaway recall DB (tests/setup-unit.ts), with a fake LlmClient.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skill-distill-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { distillSkillsFromMessages, drainSkillDistill, parseSkillCandidates, slugifySkill } from '../../src/main/skills/distill';
import * as store from '../../src/main/recall/store';
import type { LlmClient } from '../../src/main/recall/llm';

const WATERMARK = 'skill_distill_watermark';

/** Fake LLM that records prompts; replies with `reply` (or throws when it's an Error). */
function fakeLlm(reply: string | Error): LlmClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      if (reply instanceof Error) throw reply;
      return reply;
    }
  };
}

/** Seed one long user+assistant exchange (comfortably past the min-batch gate). */
function seedProcedureChat(threadId = 'T1'): void {
  store.recordMessage({
    threadId,
    turnId: 't1',
    role: 'user',
    text: `Please set up the home battery report. ${'The details are involved. '.repeat(40)}`
  });
  store.recordMessage({
    threadId,
    turnId: 't1',
    role: 'assistant',
    text: `Done — I fetched the inverter stats, converted the units, and wrote the summary file. ${'Each step needed care. '.repeat(60)}`
  });
}

function writeExistingSkill(slug: string, description: string): void {
  const fm = [
    '---',
    `name: ${JSON.stringify(slug)}`,
    `description: ${JSON.stringify(description)}`,
    'metadata:',
    '  stem:',
    '    source: agent',
    '    version: 1',
    '    created: "2026-01-01T00:00:00.000Z"',
    '    updated: "2026-01-01T00:00:00.000Z"',
    '---'
  ].join('\n');
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(join(skillsDir, slug, 'SKILL.md'), `${fm}\n\n1. Old body.\n`, 'utf8');
}

const CANDIDATE = {
  name: 'battery-report-setup',
  description: 'Builds the home battery report; use when asked for battery/inverter summaries.',
  content: '1. Fetch inverter stats.\n2. Convert units.\n3. Write the summary.\n4. Verify the totals add up.'
};

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
  store.resetEpisodic();
  store.setMeta(WATERMARK, '0');
});
afterAll(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  store.closeForTest();
});

describe('parseSkillCandidates', () => {
  it('parses candidates, slugifies names, and tolerates surrounding prose', () => {
    const out = parseSkillCandidates(`sure:\n[${JSON.stringify({ ...CANDIDATE, name: 'Battery Report Setup!' })}]`);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('battery-report-setup');
    expect(out[0].description).toBe(CANDIDATE.description);
  });

  it('caps at two skills and drops malformed/duplicate entries', () => {
    const good = (n: string) => ({ ...CANDIDATE, name: n });
    const out = parseSkillCandidates(
      JSON.stringify([
        good('one'),
        { name: 'no-content', description: 'd', content: '   ' },
        { name: '!!!', description: 'd', content: 'c' }, // slugifies to empty
        good('one'), // duplicate slug
        good('two'),
        good('three') // over the cap
      ])
    );
    expect(out.map((c) => c.name)).toEqual(['one', 'two']);
  });

  it('returns [] on non-JSON and non-array replies', () => {
    expect(parseSkillCandidates('no json here')).toEqual([]);
    expect(parseSkillCandidates('{"name":"x"}')).toEqual([]);
  });
});

describe('slugifySkill', () => {
  it('lowercases, dashes separators, trims edges', () => {
    expect(slugifySkill('  Home Assistant: PV Automation  ')).toBe('home-assistant-pv-automation');
  });
});

describe('distillSkillsFromMessages', () => {
  it('writes an agent-authored SKILL.md and advances the watermark', async () => {
    seedProcedureChat();
    const llm = fakeLlm(JSON.stringify([CANDIDATE]));
    expect(await distillSkillsFromMessages(llm)).toBe(1);

    const md = readFileSync(join(skillsDir, CANDIDATE.name, 'SKILL.md'), 'utf8');
    expect(md).toMatch(/source: agent/);
    expect(md).toMatch(/Verify the totals/);
    expect(Number(store.getMeta(WATERMARK))).toBeGreaterThan(0);

    // Nothing new since → no further model call.
    expect(await distillSkillsFromMessages(llm)).toBe(0);
    expect(llm.prompts).toHaveLength(1);
  });

  it('advances the watermark even when the model finds nothing skill-worthy', async () => {
    seedProcedureChat();
    const llm = fakeLlm('[]');
    expect(await distillSkillsFromMessages(llm)).toBe(0);
    expect(Number(store.getMeta(WATERMARK))).toBeGreaterThan(0);
  });

  it('accumulates a too-small batch: no model call, watermark unmoved', async () => {
    store.recordMessage({ threadId: 'T1', turnId: 't1', role: 'user', text: 'hi' });
    const llm = fakeLlm(JSON.stringify([CANDIDATE]));
    expect(await distillSkillsFromMessages(llm)).toBe(0);
    expect(llm.prompts).toHaveLength(0);
    expect(store.getMeta(WATERMARK)).toBe('0');

    // Once enough substance accumulates, the whole backlog is considered at once.
    seedProcedureChat();
    expect(await distillSkillsFromMessages(llm)).toBe(1);
    expect(llm.prompts[0]).toMatch(/User: hi/);
  });

  it('never overwrites an existing skill, and lists existing skills in the prompt', async () => {
    writeExistingSkill(CANDIDATE.name, 'already covers battery reports');
    seedProcedureChat();
    const llm = fakeLlm(JSON.stringify([CANDIDATE]));

    expect(await distillSkillsFromMessages(llm)).toBe(0); // skipped, not overwritten
    expect(readFileSync(join(skillsDir, CANDIDATE.name, 'SKILL.md'), 'utf8')).toMatch(/Old body/);
    expect(llm.prompts[0]).toMatch(/Existing skills/);
    expect(llm.prompts[0]).toMatch(/already covers battery reports/);
    expect(Number(store.getMeta(WATERMARK))).toBeGreaterThan(0); // still consumed
  });

  it('leaves the watermark unmoved on a model error so a later run retries', async () => {
    seedProcedureChat();
    expect(await distillSkillsFromMessages(fakeLlm(new Error('backend down')))).toBe(0);
    expect(store.getMeta(WATERMARK)).toBe('0');

    expect(await distillSkillsFromMessages(fakeLlm(JSON.stringify([CANDIDATE])))).toBe(1);
    expect(existsSync(join(skillsDir, CANDIDATE.name, 'SKILL.md'))).toBe(true);
  });

  it('force processes even a tiny batch (the manual collect-now path)', async () => {
    store.recordMessage({ threadId: 'T1', turnId: 't1', role: 'user', text: 'hi' });
    const llm = fakeLlm(JSON.stringify([CANDIDATE]));
    expect(await distillSkillsFromMessages(llm, { force: true })).toBe(1);
    expect(llm.prompts).toHaveLength(1);
  });

  it('drainSkillDistill loops through the whole backlog and stops when caught up', async () => {
    // Two batches worth of messages (batch cap is 200) — the background pass
    // would need two firings; a manual drain consumes both in one call.
    for (let i = 0; i < 210; i++) {
      store.recordMessage({ threadId: 'T1', turnId: `t${i}`, role: 'user', text: `message number ${i} with some padding text` });
    }
    const llm = fakeLlm(JSON.stringify([CANDIDATE]));
    const written = await drainSkillDistill(llm);
    expect(llm.prompts).toHaveLength(2); // one call per batch, then caught up
    expect(written).toBe(1); // same slug the second time → skipped, not rewritten
    expect(existsSync(join(skillsDir, CANDIDATE.name, 'SKILL.md'))).toBe(true);
  });

  it('does nothing while memory is disabled', async () => {
    seedProcedureChat();
    store.setMeta('recall_enabled', 'false');
    const llm = fakeLlm(JSON.stringify([CANDIDATE]));
    try {
      expect(await distillSkillsFromMessages(llm)).toBe(0);
      expect(llm.prompts).toHaveLength(0);
    } finally {
      store.setMeta('recall_enabled', 'true');
    }
  });
});
