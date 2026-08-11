// The seam between a live turn and the settle pass, exercised end to end over a
// real TurnContext.
//
// THE ABSENCE OF THIS TEST IS WHY THE ROUTING BUG SHIPPED. `skillsUsed` was
// declared on TurnContext, copied by snapshotTurnTrace, and read by decideSettle,
// and every one of those three sites had a passing unit test — because each test
// set the field by hand. Nothing in `src/` ever wrote it, so in production every
// end-of-turn authoring was a create and no skill was ever improved. A unit test
// over a pure function cannot catch a field nobody fills; only a test that starts
// where the runtime starts can.
//
// So this file deliberately does not hand-set the routing fields. It builds the
// context the normalizer builds, populates it the way PiRuntime.settleTurn does
// (inject → grade → assign → snapshot), and asks decideSettle what it sees.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-routing-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import type { PiEvent } from '../../src/server/pi/rpc';
import { newTurnContext, normalizePiEvent, snapshotTurnTrace, type TurnContext } from '../../src/server/pi/normalize';
import { gradeSkillUse } from '../../src/server/skills/grade';
import { SKILL_GATE_MIN_TOOL_CALLS, decideSettle } from '../../src/server/skills/settle';
import type { InlinedSkill } from '../../src/server/skills/inject';

const CAPTIONS_BODY = `## When to use
When the user asks what was said in a video.

## Steps
1. Run \`yt-dlp --skip-download --write-auto-sub "<url>"\` with run_command.

## Verification
A .vtt file lands next to the video id.`;

const TRAILER_BODY = `## When to use
When the user asks which track a trailer used.

## Steps
1. Look the trailer up with fetch_content.

## Verification
The soundtrack listing names the track.`;

function writeSkill(slug: string, body: string, description = 'a saved procedure'): void {
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(
    join(skillsDir, slug, 'SKILL.md'),
    `---\nname: ${JSON.stringify(slug)}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  stem:\n    source: agent\n---\n\n${body}\n`,
    'utf8'
  );
}

const ev = (o: Record<string, unknown>): PiEvent => o as unknown as PiEvent;

/** Run one tool call through the normalizer, exactly as a live turn would. */
function call(ctx: TurnContext, id: string, name: string, args: Record<string, unknown>): void {
  normalizePiEvent(ev({ type: 'tool_execution_start', toolCallId: id, toolName: name, toolInput: args }), ctx);
  normalizePiEvent(
    ev({ type: 'tool_execution_end', toolCallId: id, result: { isError: false, content: [{ type: 'text', text: 'ok' }] } }),
    ctx
  );
}

/**
 * A turn that did real work, with `inlined` put in front of it — then settled the
 * way PiRuntime.settleTurn settles one. The grading call and the assignment that
 * follows it are the two lines from runtime.ts this file exists to pin.
 */
function settledTurn(inlined: InlinedSkill[], tools: { name: string; args: Record<string, unknown> }[]) {
  const ctx = newTurnContext('t1', 'turn1');
  ctx.userText = 'what did the video say?';
  ctx.assistantText = 'Here is the transcript.';
  ctx.skillsInjected = inlined;
  tools.forEach((t, i) => call(ctx, `c${i}`, t.name, t.args));

  const injected = ctx.skillsInjected ?? [];
  if (injected.length > 0) ctx.skillsGradedUsed = gradeSkillUse(injected, ctx.trace);
  return snapshotTurnTrace(ctx, 1_000);
}

function inlined(slug: string, body: string): InlinedSkill {
  return { slug, name: slug, description: 'a saved procedure', body };
}

const RUN = (i: number) => ({ name: 'run_command', args: { command: `yt-dlp --skip-download step-${i}` } });

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('turn → snapshot → routing', () => {
  it('routes a graded skill to a patch without anyone setting the field by hand', () => {
    writeSkill('extract-video-captions', CAPTIONS_BODY);
    const turn = settledTurn(
      [inlined('extract-video-captions', CAPTIONS_BODY)],
      Array.from({ length: SKILL_GATE_MIN_TOOL_CALLS }, (_, i) => RUN(i))
    );

    // The snapshot carries both sets, and they are not the same question.
    expect(turn.skillsInjected).toEqual(['extract-video-captions']);
    expect(turn.skillsGradedUsed).toEqual(['extract-video-captions']);

    expect(decideSettle(turn, 'auto')).toMatchObject({
      fire: true,
      existing: { name: 'extract-video-captions', body: CAPTIONS_BODY }
    });
  });

  it('leaves an ungraded injection to the author rather than routing on it', () => {
    // The 2026-08-11 shape: a skill was inlined, the turn ran tools it never
    // names, and nothing graded. Injection is a cosine ranking, so there is no
    // target to route at — the author is given the library and chooses.
    writeSkill('identify-trailer-music', TRAILER_BODY);
    const turn = settledTurn(
      [inlined('identify-trailer-music', TRAILER_BODY)],
      Array.from({ length: SKILL_GATE_MIN_TOOL_CALLS }, (_, i) => RUN(i))
    );

    expect(turn.skillsInjected).toEqual(['identify-trailer-music']);
    expect(turn.skillsGradedUsed).toEqual([]);
    expect(decideSettle(turn, 'auto')).toEqual({ fire: true });
  });

  it('carries an empty graded set through a turn that had no skills at all', () => {
    // The common case, and the one where the old field was indistinguishable from
    // the broken one: both were empty, forever, and nothing said which.
    const turn = settledTurn([], Array.from({ length: SKILL_GATE_MIN_TOOL_CALLS }, (_, i) => RUN(i)));
    expect(turn.skillsInjected).toEqual([]);
    expect(turn.skillsGradedUsed).toEqual([]);
    expect(decideSettle(turn, 'auto')).toEqual({ fire: true });
  });

  it('drops a graded skill that left disk between the turn and the pass', () => {
    // Nothing is written for it, but the turn is still worth a create: the missing
    // skill has nothing to do with what this turn just did.
    const turn = settledTurn(
      [inlined('deleted-since', CAPTIONS_BODY)],
      Array.from({ length: SKILL_GATE_MIN_TOOL_CALLS }, (_, i) => RUN(i))
    );
    expect(turn.skillsGradedUsed).toEqual(['deleted-since']);
    expect(decideSettle(turn, 'auto')).toEqual({ fire: true });
  });
});
