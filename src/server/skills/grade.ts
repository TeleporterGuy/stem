import type { TraceEntry } from '../pi/normalize';

// Did the turn actually follow the skills it was given?
//
// This is the numerator of the injected-then-graded loop, and it is deliberately
// NOT a model call. Recall can afford to grade fact usage with an LLM because it
// rides along on the distill pass that was going to run anyway; there is no such
// free ride here — a per-turn judge would add a model call to every turn in the
// app to answer a question worth a fraction of one.
//
// So the signal is a proxy: a skill counts as used when the turn ran a tool that
// the skill's Steps section names. That is a weak signal in both directions. It
// misses a skill followed as pure advice with no tools, and it can credit a skill
// for a tool the model would have reached for regardless. What makes it good
// enough is what the number is FOR: it is a small reordering term inside a cosine
// gate (SKILL_USAGE_WEIGHT = 0.1), never an admission or rejection on its own, and
// it decays. A proxy that is right more often than chance and cannot let anything
// through the gate is worth more than a judge nobody can afford to run.
//
// The failure we care about is the opposite one anyway: a skill injected turn
// after turn that never coincides with any of its own tools is almost certainly
// dead weight, and that is exactly the case this catches.
//
// Two corrections, 2026-08-11, after a false credit in the live library.
//
// First, generic tools no longer earn credit (GENERIC_TOOLS below). Nearly every
// skill's Steps mention `run_command` or `fetch_content`, and nearly every gated
// turn calls one, so "ran a tool this skill names" had degenerated toward "did the
// turn use a tool at all": `identify-youtube-trailer-music` was credited on a turn
// that fetched an unrelated URL, because its step 7 says `fetch_content`. A proxy
// that fires on almost every turn is not right more often than chance; it is a
// constant, and a constant reordering term is just noise with a cost.
//
// Second, removing them alone would have made the entire live library ungradeable
// — a source-check found `fetch_content` and `get_search_content` are the only
// real tool names any live skill's Steps mention. So the same tokens are matched
// a second way, against the ARGUMENTS of the turn's tool calls rather than the
// tool names: a skill that says `yt-dlp --skip-download` is credited when a
// command this turn actually ran `yt-dlp`. That restores the coverage the first
// change removed, and it restores it with more precision than the original rule
// had — running `yt-dlp` is following the procedure, and unlike "called a tool"
// it is not satisfiable by reaching for any tool for any reason.
//
// A skill whose Steps yield no distinctive tokens at all stays ungradeable and
// ranks neutral. That is correct: there is no evidence to be had.

/**
 * Tools callable for any reason on any turn, so naming one in Steps carries no
 * evidence that the turn followed the skill. Matching them was the whole of the
 * 08-11 false credit.
 *
 * `read` and `write` are deliberately NOT here: the token regex below requires a
 * separator and at least 5 characters, so neither can ever be extracted in the
 * first place — listing them would be a dead letter that reads like a live rule.
 */
export const GENERIC_TOOLS = new Set(['run_command', 'fetch_content', 'web_search', 'get_search_content']);

/**
 * The distinctive tokens a skill's Steps section names, lowercased: tool names,
 * CLI binaries, flags, subcommands. One extraction feeds both signals — an exact
 * match against the turn's tool names, and a substring match against its tool
 * arguments — because a `yt-dlp` in Steps is the same claim either way: this turn
 * should have touched that specific thing.
 */
export function toolsNamedIn(body: string): Set<string> {
  const steps = sectionText(body, 'Steps');
  const names = new Set<string>();
  // Tool names appear as bare identifiers or in backticks: `manage_skill`,
  // agent-browser, yt-dlp. Underscored or hyphenated words of a decent
  // length, which keeps ordinary English out without needing a tool registry
  // here (one would have to be threaded through and kept in sync).
  for (const match of steps.matchAll(/[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+/gi)) {
    const word = match[0].toLowerCase();
    if (word.length >= 5 && !GENERIC_TOOLS.has(word)) names.add(word);
  }
  return names;
}

/**
 * The text under `## <heading>`, up to the next heading of any level. Exported
 * for dedup.ts, which compares two bodies' Steps sections and has to mean exactly
 * the same span of text by "Steps" that grading does.
 */
export function sectionText(body: string, heading: string): string {
  const start = body.search(new RegExp(`^##\\s+${heading}\\s*$`, 'im'));
  if (start === -1) return body;
  const rest = body.slice(start).replace(/^[^\n]*\n/, '');
  const end = rest.search(/^#{1,6}\s/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Which of the injected skills the turn shows evidence of following. `skills` is
 * what was inlined this turn — a skill listed by name only was never given its
 * steps, so it can neither be followed nor fairly graded.
 */
export function gradeSkillUse(skills: { slug: string; body: string }[], trace: TraceEntry[]): string[] {
  if (skills.length === 0 || trace.length === 0) return [];
  const called = new Set(trace.map((t) => (t.name ?? '').toLowerCase()).filter(Boolean));
  // `args` is already the serialized, redacted, truncated JSON the trace keeps
  // (see normalize.ts): the same text skill authoring reads, so a token found in
  // it is a thing the turn demonstrably passed to a tool. Joined per entry rather
  // than concatenated so no token can be matched across a call boundary.
  const argsText = trace
    .map((t) => t.args ?? '')
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  if (called.size === 0 && !argsText) return [];
  const used: string[] = [];
  for (const skill of skills) {
    for (const token of toolsNamedIn(skill.body)) {
      // Either signal is enough. Substring rather than word match on the args:
      // the token sits inside a JSON string next to quotes, flags and paths
      // (`{"command":"yt-dlp --skip-download …"}`), and it is distinctive enough
      // by construction — generic tool names are already out of the set — that
      // an incidental substring hit is not the failure mode worth guarding.
      if (called.has(token) || argsText.includes(token)) {
        used.push(skill.slug);
        break;
      }
    }
  }
  return used;
}
