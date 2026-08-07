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

/** Tool names mentioned in the skill body, lowercased. */
export function toolsNamedIn(body: string): Set<string> {
  const steps = sectionText(body, 'Steps');
  const names = new Set<string>();
  // Tool names appear as bare identifiers or in backticks: `run_command`,
  // web_search, fetch_content. Underscored or hyphenated words of a decent
  // length, which keeps ordinary English out without needing a tool registry
  // here (one would have to be threaded through and kept in sync).
  for (const match of steps.matchAll(/[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+/gi)) {
    const word = match[0].toLowerCase();
    if (word.length >= 5) names.add(word);
  }
  return names;
}

/** The text under `## <heading>`, up to the next heading of any level. */
function sectionText(body: string, heading: string): string {
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
  if (called.size === 0) return [];
  const used: string[] = [];
  for (const skill of skills) {
    for (const name of toolsNamedIn(skill.body)) {
      if (called.has(name)) {
        used.push(skill.slug);
        break;
      }
    }
  }
  return used;
}
