// Grading is the numerator of the injected-then-graded loop, and it is a proxy
// rather than a judge: a skill counts as followed when the turn touched something
// distinctive its Steps section names — as a tool it called, or inside the
// arguments it passed one. These cases pin what that proxy actually claims — it is
// a small reordering term inside a cosine gate, never an admission or a rejection
// — so they check the direction its errors run rather than a stricter contract it
// never promised. The case that matters most is the one it is FOR: a skill
// injected turn after turn that never coincides with anything of its own.
import { describe, expect, it } from 'vitest';
import { GENERIC_TOOLS, gradeSkillUse, toolsNamedIn } from '../../src/server/skills/grade';
import type { TraceEntry } from '../../src/server/pi/normalize';

const CAPTIONS = `## When to use
When the user asks what was said in a video that has captions.

## Steps
1. Call \`run_command\` with \`agent-browser open "<url>"\`.
2. Click "Show transcript".

## Verification
The transcript panel lists timestamped lines.`;

function call(name: string, args = '{}'): TraceEntry {
  return { id: `c-${name}`, name, args, result: 'ok' };
}

describe('toolsNamedIn', () => {
  it('reads distinctive names out of the Steps section, backticked or bare', () => {
    expect([...toolsNamedIn(CAPTIONS)]).toContain('agent-browser');
    expect([...toolsNamedIn('## Steps\n1. Then call manage_skill with the new body.')]).toContain('manage_skill');
  });

  it('drops the tools any turn might call for any reason', () => {
    // The 08-11 defect in one assertion: nearly every skill's Steps name one of
    // these and nearly every gated turn calls one, so matching them made the
    // proxy fire on almost every turn — a constant, not a signal.
    const body = `## Steps\n1. Use run_command.\n2. Then fetch_content, web_search and get_search_content.`;
    expect([...toolsNamedIn(body)]).toEqual([]);
    for (const tool of GENERIC_TOOLS) expect([...toolsNamedIn(`## Steps\n1. Call ${tool}.`)]).toEqual([]);
  });

  it('ignores names outside Steps', () => {
    // "When to use" describes the situation and "Verification" describes the
    // result; neither is a claim that the turn was supposed to do that, so
    // crediting from them would inflate every skill that merely mentions one.
    const body = `## When to use
When yt-dlp is installed.

## Steps
1. Click "Show transcript".

## Verification
Check with agent-browser.`;
    expect([...toolsNamedIn(body)]).toEqual([]);
  });

  it('does not mistake ordinary English for a tool name', () => {
    // The rule is a shape, not a registry: a separator plus enough length. Plain
    // words never carry one, which is what keeps prose out without threading a
    // tool list through here and keeping it in sync.
    expect([...toolsNamedIn('## Steps\n1. Open the menu and click the transcript button, then copy the text.')]).toEqual([]);
  });

  it('lowercases what it finds so the trace can be matched case-blind', () => {
    expect([...toolsNamedIn('## Steps\n1. Call Manage_Skill.')]).toEqual(['manage_skill']);
  });

  it('reads the whole body when there is no Steps heading', () => {
    // Off-contract bodies still reach grading (older files, hand-written skills).
    // Reading the whole thing keeps the proxy erring toward crediting, which is
    // the harmless direction — it can only soften a demotion, never admit a skill
    // through the cosine gate.
    expect([...toolsNamedIn('Just call manage_skill twice.')]).toEqual(['manage_skill']);
  });
});

describe('gradeSkillUse', () => {
  it('credits a skill whose Steps name a distinctive tool the turn actually called', () => {
    const body = '## Steps\n1. Call manage_skill with the improved body.';
    expect(gradeSkillUse([{ slug: 'improve-a-skill', body }], [call('manage_skill')])).toEqual(['improve-a-skill']);
  });

  it('credits a skill whose distinctive token shows up in what the turn ran', () => {
    // The signal that replaces generic-tool matching. `run_command` proves
    // nothing; `run_command` carrying yt-dlp is the procedure being followed.
    const body = '## Steps\n1. Run `yt-dlp --skip-download --write-auto-sub "$VIDEO_URL"`.';
    const trace = [call('run_command', '{"command":"yt-dlp --skip-download --write-auto-sub https://youtu.be/abc"}')];
    expect(gradeSkillUse([{ slug: 'extract-youtube-transcript', body }], trace)).toEqual([
      'extract-youtube-transcript'
    ]);
  });

  it('does not credit a skill for a generic tool it merely mentions', () => {
    // The false credit of 2026-08-11: `identify-youtube-trailer-music` names
    // fetch_content in a caveat, the turn fetched an unrelated URL, and the skill
    // was credited with a use it had nothing to do with. Its usage rate then
    // bought it a standing boost on every later ranking.
    const body = `## Steps
1. Search the video description for the track name.
2. If the description is empty, fetch_content sometimes fails on this host — skip it.`;
    const trace = [
      call('fetch_content', '{"url":"https://example.com/an-unrelated-article"}'),
      call('run_command', '{"command":"ls ~/Downloads"}')
    ];
    expect(gradeSkillUse([{ slug: 'identify-youtube-trailer-music', body }], trace)).toEqual([]);
  });

  it('never credits a skill whose Steps hold no distinctive tokens', () => {
    // Ungradeable by construction, and correct: there is no evidence to be had,
    // so the skill ranks neutral rather than being credited or punished.
    const body = '## Steps\n1. Ask the user which room they mean.\n2. Say the answer.';
    const trace = [call('run_command', '{"command":"yt-dlp --version"}'), call('web_search', '{"query":"anything"}')];
    expect(gradeSkillUse([{ slug: 'advice-only', body }], trace)).toEqual([]);
  });

  it('does not credit a skill whose tools never appear', () => {
    // This is the failure the number exists to catch: injected over and over,
    // never coinciding with anything of its own, almost certainly dead weight.
    expect(gradeSkillUse([{ slug: 'extract-video-captions', body: CAPTIONS }], [call('web_search')])).toEqual([]);
  });

  it('credits each skill at most once however many of its tokens matched', () => {
    const body = '## Steps\n1. Use manage_skill.\n2. Then run `yt-dlp`.';
    const trace = [call('manage_skill'), call('run_command', '{"command":"yt-dlp -F url"}')];
    expect(gradeSkillUse([{ slug: 'both', body }], trace)).toEqual(['both']);
  });

  it('grades every injected skill independently', () => {
    const searcher = '## Steps\n1. Call manage_skill to record the part number.';
    const used = gradeSkillUse(
      [
        { slug: 'extract-video-captions', body: CAPTIONS },
        { slug: 'find-parts', body: searcher }
      ],
      [call('manage_skill')]
    );
    expect(used).toEqual(['find-parts']);
  });

  it('grades nothing on an empty trace or an empty skill list', () => {
    // A turn that called no tools is not evidence against the skills it was given
    // — it is no evidence at all, and recording a miss for it would demote skills
    // for being offered on a conversational turn.
    expect(gradeSkillUse([{ slug: 'extract-video-captions', body: CAPTIONS }], [])).toEqual([]);
    expect(gradeSkillUse([], [call('manage_skill')])).toEqual([]);
  });

  it('ignores trace entries with no tool name and no arguments', () => {
    expect(gradeSkillUse([{ slug: 'extract-video-captions', body: CAPTIONS }], [{ id: 'c1' }])).toEqual([]);
  });

  it('matches a tool the trace reports in another case', () => {
    const body = '## Steps\n1. Call manage_skill.';
    expect(gradeSkillUse([{ slug: 'improve-a-skill', body }], [call('MANAGE_SKILL')])).toEqual(['improve-a-skill']);
    // And the same case-blindness on the argument side, where a command line can
    // carry any capitalization the user typed.
    const captions = [call('run_command', '{"command":"AGENT-BROWSER open https://youtu.be/abc"}')];
    expect(gradeSkillUse([{ slug: 'extract-video-captions', body: CAPTIONS }], captions)).toEqual([
      'extract-video-captions'
    ]);
  });
});
