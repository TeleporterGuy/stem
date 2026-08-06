// Grading is the numerator of the injected-then-graded loop, and it is a proxy
// rather than a judge: a skill counts as followed when the turn ran a tool its
// Steps section names. These cases pin what that proxy actually claims — it is a
// small reordering term inside a cosine gate, never an admission or a rejection —
// so they check the direction its errors run rather than a stricter contract it
// never promised. The case that matters most is the one it is FOR: a skill
// injected turn after turn that never coincides with any of its own tools.
import { describe, expect, it } from 'vitest';
import { gradeSkillUse, toolsNamedIn } from '../../src/server/skills/grade';
import type { TraceEntry } from '../../src/server/pi/normalize';

const CAPTIONS = `## When to use
When the user asks what was said in a video that has captions.

## Steps
1. Call \`run_command\` with \`agent-browser open "<url>"\`.
2. Click "Show transcript".

## Verification
The transcript panel lists timestamped lines.`;

function call(name: string): TraceEntry {
  return { id: `c-${name}`, name, args: '{}', result: 'ok' };
}

describe('toolsNamedIn', () => {
  it('reads tool names out of the Steps section, backticked or bare', () => {
    expect([...toolsNamedIn(CAPTIONS)]).toContain('run_command');
    expect([...toolsNamedIn('## Steps\n1. Then web_search for the model number.')]).toContain('web_search');
  });

  it('ignores names outside Steps', () => {
    // "When to use" describes the situation and "Verification" describes the
    // result; neither is a claim that the turn was supposed to call that tool, so
    // crediting from them would inflate every skill that merely mentions one.
    const body = `## When to use
When run_command is available.

## Steps
1. Click "Show transcript".

## Verification
Check with fetch_content.`;
    expect([...toolsNamedIn(body)]).toEqual([]);
  });

  it('does not mistake ordinary English for a tool name', () => {
    // The rule is a shape, not a registry: a separator plus enough length. Plain
    // words never carry one, which is what keeps prose out without threading a
    // tool list through here and keeping it in sync.
    expect([...toolsNamedIn('## Steps\n1. Open the menu and click the transcript button, then copy the text.')]).toEqual([]);
  });

  it('lowercases what it finds so the trace can be matched case-blind', () => {
    expect([...toolsNamedIn('## Steps\n1. Call Run_Command.')]).toEqual(['run_command']);
  });

  it('reads the whole body when there is no Steps heading', () => {
    // Off-contract bodies still reach grading (older files, hand-written skills).
    // Reading the whole thing keeps the proxy erring toward crediting, which is
    // the harmless direction — it can only soften a demotion, never admit a skill
    // through the cosine gate.
    expect([...toolsNamedIn('Just call run_command twice.')]).toEqual(['run_command']);
  });
});

describe('gradeSkillUse', () => {
  it('credits a skill whose Steps name a tool the turn actually called', () => {
    expect(gradeSkillUse([{ slug: 'extract-video-captions', body: CAPTIONS }], [call('run_command')])).toEqual([
      'extract-video-captions'
    ]);
  });

  it('does not credit a skill whose tools never appear', () => {
    // This is the failure the number exists to catch: injected over and over,
    // never coinciding with its own tools, almost certainly dead weight.
    expect(gradeSkillUse([{ slug: 'extract-video-captions', body: CAPTIONS }], [call('web_search')])).toEqual([]);
  });

  it('credits each skill at most once however many of its tools ran', () => {
    const body = '## Steps\n1. Use run_command.\n2. Then use web_search.';
    expect(gradeSkillUse([{ slug: 'both', body }], [call('run_command'), call('web_search')])).toEqual(['both']);
  });

  it('grades every injected skill independently', () => {
    const searcher = '## Steps\n1. Use web_search for the part number.';
    const used = gradeSkillUse(
      [
        { slug: 'extract-video-captions', body: CAPTIONS },
        { slug: 'find-parts', body: searcher }
      ],
      [call('web_search')]
    );
    expect(used).toEqual(['find-parts']);
  });

  it('grades nothing on an empty trace or an empty skill list', () => {
    // A turn that called no tools is not evidence against the skills it was given
    // — it is no evidence at all, and recording a miss for it would demote skills
    // for being offered on a conversational turn.
    expect(gradeSkillUse([{ slug: 'extract-video-captions', body: CAPTIONS }], [])).toEqual([]);
    expect(gradeSkillUse([], [call('run_command')])).toEqual([]);
  });

  it('ignores trace entries with no tool name', () => {
    expect(gradeSkillUse([{ slug: 'extract-video-captions', body: CAPTIONS }], [{ id: 'c1' }])).toEqual([]);
  });

  it('matches a tool the trace reports in another case', () => {
    expect(gradeSkillUse([{ slug: 'extract-video-captions', body: CAPTIONS }], [call('RUN_COMMAND')])).toEqual([
      'extract-video-captions'
    ]);
  });
});
