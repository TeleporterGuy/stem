// The end-of-turn pass. Almost everything worth testing here is a refusal: three
// of the four skip reasons are about restraint rather than cost, and the order
// they are checked in decides what the log later says happened. The routing half
// is the other half of the same care — a turn that already loaded a skill must
// improve that one rather than grow a near-duplicate beside it.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-settle-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { SKILL_GATE_MIN_TOOL_CALLS, decideSettle, settleSkills } from '../../src/server/skills/settle';
import type { SettledTurnTrace, TraceEntry } from '../../src/server/pi/normalize';
import type { LlmClient } from '../../src/server/recall/llm';

const BODY = `## When to use
When the user asks what was said in a video that has captions.

## Steps
1. Open the watch URL with \`agent-browser open "<url>"\`.

## Verification
The transcript panel lists timestamped lines.`;

function trace(count: number): TraceEntry[] {
  return Array.from({ length: count }, (_, i) => ({ id: `c${i}`, name: 'run_command', args: '{}', result: 'ok' }));
}

function turn(over: Partial<SettledTurnTrace> = {}): SettledTurnTrace {
  return {
    threadId: 't',
    turnId: 'u',
    endedAt: 0,
    userText: 'what did the video say?',
    assistantText: 'Here is the transcript.',
    trace: trace(SKILL_GATE_MIN_TOOL_CALLS),
    skillsUsed: [],
    memoryTainted: false,
    isScheduled: false,
    ...over
  };
}

function writeSkill(slug: string, body = BODY): void {
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(
    join(skillsDir, slug, 'SKILL.md'),
    `---\nname: ${JSON.stringify(slug)}\ndescription: "pull captions out of a video"\n---\n\n${body}\n`,
    'utf8'
  );
}

/** An LlmClient that returns each reply in turn and records the prompts it saw. */
function scriptedLlm(replies: string[]): LlmClient & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      return replies[Math.min(i++, replies.length - 1)];
    }
  };
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('decideSettle', () => {
  it('fires on a turn that did enough work', () => {
    expect(decideSettle(turn(), 'auto')).toEqual({ fire: true });
  });

  it('does not fire one tool call short of the gate', () => {
    // 73% of real turns call no tools at all, so the cheap deterministic gate is
    // free on nearly three turns in four and the model is only asked about the
    // ~12% where something actually happened.
    expect(decideSettle(turn({ trace: trace(SKILL_GATE_MIN_TOOL_CALLS - 1) }), 'auto')).toEqual({
      fire: false,
      reason: 'below-gate'
    });
    expect(decideSettle(turn({ trace: [] }), 'auto')).toMatchObject({ reason: 'below-gate' });
  });

  it('never fires with the mode off', () => {
    expect(decideSettle(turn(), 'off')).toEqual({ fire: false, reason: 'mode-off' });
  });

  it('refuses a tainted turn', () => {
    // The turn read inside a folder marked do-not-memorize. A skill written from it
    // would launder that content into a file injected on every later turn, which is
    // exactly what the flag exists to stop.
    expect(decideSettle(turn({ memoryTainted: true }), 'auto')).toEqual({ fire: false, reason: 'tainted' });
  });

  it('refuses a scheduled turn', () => {
    // Nobody is watching, so neither a card nor a silent write is honest.
    expect(decideSettle(turn({ isScheduled: true }), 'ask')).toEqual({ fire: false, reason: 'scheduled' });
  });

  it('reports the true reason when several apply', () => {
    // The reason is what lands in the log, and "below-gate" for a turn that was
    // actually tainted would send anyone tuning the threshold after a ghost.
    expect(decideSettle(turn({ memoryTainted: true, trace: [] }), 'auto')).toMatchObject({ reason: 'tainted' });
    expect(decideSettle(turn({ memoryTainted: true, isScheduled: true }), 'auto')).toMatchObject({ reason: 'tainted' });
    expect(decideSettle(turn({ isScheduled: true, trace: [] }), 'auto')).toMatchObject({ reason: 'scheduled' });
  });
});

describe('routing', () => {
  it('routes to a patch carrying the skill\'s current text', () => {
    writeSkill('extract-video-captions');
    const decision = decideSettle(turn({ skillsUsed: ['extract-video-captions'] }), 'auto');
    expect(decision).toMatchObject({
      fire: true,
      existing: { name: 'extract-video-captions', description: 'pull captions out of a video', body: BODY }
    });
  });

  it('falls back to a create when the named skill is gone from disk', () => {
    // Slugs come off the turn context, and a skill can be removed or merged
    // between injection and settle. Failing the whole pass over a stale name would
    // lose a skill that has nothing to do with the missing one.
    expect(decideSettle(turn({ skillsUsed: ['deleted-since'] }), 'auto')).toEqual({ fire: true });
  });

  it('takes the first skill that still exists', () => {
    // Several may have been inlined; the first ranked highest against the message,
    // so it is the one the turn was actually working from.
    writeSkill('second-skill');
    const decision = decideSettle(turn({ skillsUsed: ['gone', 'second-skill'] }), 'auto');
    expect(decision).toMatchObject({ existing: { name: 'second-skill' } });
  });
});

describe('settleSkills', () => {
  it('makes no model call when the gate says no', async () => {
    // The whole point of a deterministic gate is that the expensive question is
    // never asked on the turns it would waste.
    const llm = scriptedLlm(['{"skill":null}']);
    const res = await settleSkills(turn({ trace: [] }), 'auto', llm);
    expect(res).toEqual({ decision: { fire: false, reason: 'below-gate' } });
    expect(llm.prompts).toHaveLength(0);
  });

  it('makes no model call with the mode off', async () => {
    const llm = scriptedLlm(['{"skill":null}']);
    await settleSkills(turn(), 'off', llm);
    expect(llm.prompts).toHaveLength(0);
  });

  it('returns the authored draft without writing anything', async () => {
    // Writing is the bridge's job, so the mode, the card and the validator behave
    // identically whichever surface proposed the skill.
    const llm = scriptedLlm([
      JSON.stringify({
        skill: { name: 'extract-video-captions', description: 'Pull the captions out of a video the user asks about.', body: BODY }
      })
    ]);
    const res = await settleSkills(turn(), 'auto', llm);
    expect(res.decision).toEqual({ fire: true });
    expect(res.author).toMatchObject({ ok: true, patched: false, attempts: 1 });
    expect(llm.prompts).toHaveLength(1);
  });

  it('passes a decline straight back', async () => {
    const llm = scriptedLlm(['{"skill":null,"reason":"one-off errand"}']);
    const res = await settleSkills(turn(), 'auto', llm);
    expect(res.author).toMatchObject({ ok: false, reason: 'declined', detail: 'one-off errand' });
  });

  it('hands the author the existing skill when the turn used one', async () => {
    writeSkill('extract-video-captions');
    const llm = scriptedLlm(['{"skill":null,"reason":"the skill did its job"}']);
    const res = await settleSkills(turn({ skillsUsed: ['extract-video-captions'] }), 'auto', llm);
    expect(res.decision).toMatchObject({ existing: { name: 'extract-video-captions' } });
    expect(llm.prompts[0]).toContain('The skill this turn used:');
    expect(llm.prompts[0]).toContain('The transcript panel lists timestamped lines.');
  });

  it('carries the /learn focus through to the prompt', async () => {
    const llm = scriptedLlm(['{"skill":null}']);
    await settleSkills(turn(), 'auto', llm, { focus: 'how to get captions' });
    expect(llm.prompts[0]).toContain('how to get captions');
  });
});
