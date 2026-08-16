// Real-inference skill-authoring evaluation against an OpenAI-compatible endpoint.
// This is an explicit release gate rather than a unit test because it consumes
// model tokens and sends fixtures harvested from real conversations to whatever
// endpoint is configured.
//
// What it measures, in the order the failures actually hurt:
//   1. FIRE RATE. Positives must produce a skill; negatives must produce
//      {"skill": null}. Precision and recall are reported separately, because they
//      fail for opposite reasons and only one of them produced the 25-skill library
//      this rebuild deletes: over-firing. A single fire on a negative is loud and
//      fails the run.
//   2. CONTRACT. Every skill it does produce must satisfy contract.ts — measured on
//      the FIRST reply, without the shipped retry, so the number says whether the
//      contract prose still teaches the rules rather than whether the retry loop
//      can rescue them.
//   3. CONTENT. Each positive names expectTokens — the command, flag, or URL that
//      actually worked. A body that omits them is a retelling, which is the exact
//      failure mode of the distiller being replaced.
//
// Required:
//   STEM_SKILL_EVAL_BASE_URL=http://127.0.0.1:1234/v1
//   STEM_SKILL_EVAL_MODEL=model-id
// Optional: STEM_SKILL_EVAL_API_KEY
//
// Fixtures come from `npm run fixtures:skills` and must be labelled by hand first;
// the run refuses to start while any case still says expect:"TODO".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---- floors ----
// Firing on a negative is the failure this whole rebuild exists to prevent: every
// skill costs context on every turn and a bad one gets FOLLOWED. There is no
// acceptable rate above zero, so the floor is exact.
const FIRE_PRECISION_FLOOR = 1.0;
// Declining is what SKILL_AUTHORING_INSTRUCTIONS calls the normal answer, and the
// positives are only "a human thinks there is something here" — not "the model is
// wrong to pass". The floor is set to catch the prompt going silent altogether,
// not to chase every case.
const FIRE_RECALL_FLOOR = 0.6;
// Measured on the first reply only. authorSkill() retries once with the violations,
// so production survives a miss; a first-shot rate under this means the contract
// text stopped carrying its own rules and the retry is doing all the work.
const CONTRACT_VALID_FLOOR = 0.9;
// Per-token, across every positive that fired. Some drift is expected (a model may
// paraphrase a path); a collapse here means bodies went back to narration.
const CONTENT_TOKEN_FLOOR = 0.7;

const baseUrl = process.env.STEM_SKILL_EVAL_BASE_URL?.replace(/\/$/, '');
const model = process.env.STEM_SKILL_EVAL_MODEL;
const apiKey = process.env.STEM_SKILL_EVAL_API_KEY;
if (!baseUrl || !model) {
  console.error('Set STEM_SKILL_EVAL_BASE_URL and STEM_SKILL_EVAL_MODEL to run the real authoring gate.');
  process.exit(2);
}

/**
 * The gate has to grade the prompt that actually ships, so both halves are lifted
 * straight out of the source rather than paraphrased here where they would silently
 * drift. Reading the source beats compiling it: author.ts pulls in the LLM client
 * and the trace types, none of which this script needs.
 *
 * Both constants are deliberately kept unmerged in the source — the first sets the
 * fire rate, the second sets the shape — so a regression in one is visible on its
 * own. The throw on `${` is what keeps this honest: an interpolation would mean the
 * shipped text and the lifted text are no longer the same string.
 */
function liftConstant(relPath, name) {
  const source = readFileSync(join(ROOT, relPath), 'utf8');
  const match = source.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;\\n`));
  if (!match) throw new Error(`${name} not found in ${relPath} — update skill-author-eval.mjs`);
  if (/\$\{/.test(match[1])) throw new Error(`${name} gained an interpolation — skill-author-eval.mjs cannot lift it verbatim`);
  return match[1].replace(/\\`/g, '`');
}
const AUTHORING_INSTRUCTIONS = liftConstant('src/server/skills/author.ts', 'SKILL_AUTHORING_INSTRUCTIONS');
const CONTRACT_TEXT = liftConstant('src/server/skills/contract.ts', 'SKILL_CONTRACT_TEXT');

// ---- prompt assembly: a port of renderEvidence + buildAuthorPrompt (author.ts) ----
// The script cannot import the TS module, so these are reimplementations. They must
// stay byte-identical to `renderTraceEntry` / `renderEvidence` / `buildAuthorPrompt`
// in src/server/skills/author.ts — that is the source of truth; if the rendering
// changes there, change it here or the gate grades a prompt nobody ships.
function renderTraceEntry(entry, index) {
  const head = `${index + 1}. ${entry.name ?? 'tool'}${entry.isError ? ' → FAILED' : ''}`;
  const lines = [head];
  if (entry.args) lines.push(`   args: ${entry.args}`);
  if (entry.result) lines.push(`   result: ${entry.result.replace(/\n/g, '\n   ')}`);
  return lines.join('\n');
}

function renderEvidence(input) {
  const parts = [];
  if (input.focus?.trim()) parts.push(`What the user asked to be captured:\n${input.focus.trim()}`);
  if (input.userText.trim()) parts.push(`The user's message:\n${input.userText.trim()}`);
  parts.push(
    input.trace.length > 0
      ? `What the assistant did, in order:\n${input.trace.map(renderTraceEntry).join('\n')}`
      : 'What the assistant did, in order:\n(no tool calls)'
  );
  if (input.assistantText.trim()) parts.push(`What the assistant replied:\n${input.assistantText.trim()}`);
  if (input.existing) {
    parts.push(
      `The skill this turn used:\nname: ${input.existing.name}\ndescription: ${input.existing.description}\n\n${input.existing.body}`
    );
  }
  return parts.join('\n\n');
}

function buildAuthorPrompt(input) {
  // No SKILL_PATCH_INSTRUCTIONS branch: the harvested fixtures carry no `existing`
  // skill, so the patch path has nothing to grade here.
  return [AUTHORING_INSTRUCTIONS, CONTRACT_TEXT, '---', renderEvidence(input)].join('\n\n');
}

// ---- contract validation: a port of validateSkill (contract.ts) ----
// src/server/skills/contract.ts is the source of truth. This is a port, kept to the
// same rules and the same limits; when a rule moves there, move it here too.
const SKILL_NAME_MAX = 64;
const SKILL_DESCRIPTION_MAX = 160;
const SKILL_BODY_MAX_BYTES = 4_096;
const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_REQUIRED_SECTIONS = ['## When to use', '## Steps', '## Verification'];

function words(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function restatesName(name, description) {
  const nameWords = words(name);
  const descWords = words(description);
  if (nameWords.length === 0 || descWords.length < nameWords.length) return false;
  return nameWords.every((w, i) => descWords[i] === w);
}

function sentenceCount(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return 1 + (trimmed.slice(0, -1).match(/[.!?]\s+[A-Z]/g)?.length ?? 0);
}

function sectionRe(heading) {
  return new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
}

function validateSkill(draft) {
  const violations = [];
  const name = String(draft.name ?? '').trim();
  const description = String(draft.description ?? '').trim();
  const body = String(draft.body ?? '').trim();

  if (!name) violations.push('name is empty');
  else if (!SKILL_SLUG_RE.test(name)) violations.push(`name is not a slug: ${JSON.stringify(name)}`);
  else if (name.length > SKILL_NAME_MAX) violations.push(`name is ${name.length} chars (max ${SKILL_NAME_MAX})`);

  if (!description) {
    violations.push('description is empty');
  } else {
    if (description.length > SKILL_DESCRIPTION_MAX) violations.push(`description is ${description.length} chars (max ${SKILL_DESCRIPTION_MAX})`);
    if (sentenceCount(description) > 1) violations.push('description is more than one sentence');
    if (description.includes('\n')) violations.push('description is more than one line');
    if (name && restatesName(name, description)) violations.push('description restates the name');
  }

  if (!body) {
    violations.push('body is empty');
  } else {
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > SKILL_BODY_MAX_BYTES) violations.push(`body is ${bytes} bytes (max ${SKILL_BODY_MAX_BYTES})`);
    if (/^---\s*$/m.test(body.split('\n')[0] ?? '')) violations.push('body includes front-matter');
    const missing = SKILL_REQUIRED_SECTIONS.filter((h) => !sectionRe(h).test(body));
    if (missing.length > 0) {
      violations.push(`body is missing ${missing.join(', ')}`);
    } else {
      const at = SKILL_REQUIRED_SECTIONS.map((h) => body.search(sectionRe(h)));
      if (at[0] > at[1] || at[1] > at[2]) violations.push('body sections are out of order');
    }
  }
  return violations;
}

// ---- reply parsing: a port of parseAuthorReply (author.ts) ----
function parseAuthorReply(output) {
  const trimmed = String(output ?? '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return { kind: 'unparseable' };
  let parsed;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { kind: 'unparseable' };
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'unparseable' };
  const skill = parsed.skill;
  if (skill === null || skill === undefined) {
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'nothing reusable';
    return { kind: 'declined', reason };
  }
  if (typeof skill !== 'object') return { kind: 'unparseable' };
  const text = typeof skill.body === 'string' ? skill.body : typeof skill.content === 'string' ? skill.content : '';
  if (typeof skill.name !== 'string' || typeof skill.description !== 'string' || !text) return { kind: 'unparseable' };
  return { kind: 'skill', draft: { name: skill.name.trim(), description: skill.description.trim(), body: text.trim() } };
}

// ---- fixtures ----
const fixturePath = join(ROOT, 'tests/fixtures/skill-authoring-golden.json');
let fixture;
try {
  fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
} catch {
  console.error(`No fixture at ${fixturePath}. Run: npm run fixtures:skills`);
  process.exit(2);
}

const cases = [...(fixture.positives ?? []), ...(fixture.negatives ?? [])];
const unlabelled = cases.filter((c) => c.expect !== 'skill' && c.expect !== 'none');
if (unlabelled.length > 0) {
  console.error(`${unlabelled.length}/${cases.length} fixture case(s) are still unlabelled (expect:"TODO").`);
  console.error('A gate cannot grade a label nobody wrote. Open the fixture and resolve each one');
  console.error('to "skill" or "none" with a reason in "why", then re-run.');
  console.error(`  ${fixturePath}`);
  for (const c of unlabelled.slice(0, 10)) console.error(`    ${c.id}`);
  if (unlabelled.length > 10) console.error(`    … and ${unlabelled.length - 10} more`);
  process.exit(2);
}
if (cases.length === 0) {
  console.error('Fixture has no cases.');
  process.exit(2);
}

async function complete(prompt) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content ?? '';
}

// ---- run ----
let firedOnPositive = 0;
let firedOnNegative = 0;
let expectedFires = 0;
let drafts = 0;
let contractValid = 0;
let tokensExpected = 0;
let tokensFound = 0;
let unparseable = 0;
const falseFires = [];
const contractFailures = [];

for (const test of cases) {
  const shouldFire = test.expect === 'skill';
  if (shouldFire) expectedFires += 1;

  let raw;
  try {
    raw = await complete(buildAuthorPrompt(test.input));
  } catch (error) {
    console.error(`${test.id}: request failed — ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }

  const parsed = parseAuthorReply(raw);
  if (parsed.kind === 'unparseable') {
    unparseable += 1;
    console.log(`${test.id.padEnd(24)} expect=${test.expect.padEnd(5)} UNPARSEABLE`);
    continue;
  }
  if (parsed.kind === 'declined') {
    const verdict = shouldFire ? 'MISS' : 'ok';
    console.log(`${test.id.padEnd(24)} expect=${test.expect.padEnd(5)} declined  ${verdict}  (${parsed.reason})`);
    continue;
  }

  drafts += 1;
  if (shouldFire) firedOnPositive += 1;
  else {
    firedOnNegative += 1;
    falseFires.push({ id: test.id, why: test.why, draft: parsed.draft });
  }

  const violations = validateSkill(parsed.draft);
  if (violations.length === 0) contractValid += 1;
  else contractFailures.push({ id: test.id, violations });

  const tokens = shouldFire ? (test.expectTokens ?? []) : [];
  const bodyLower = parsed.draft.body.toLowerCase();
  const hits = tokens.filter((t) => bodyLower.includes(String(t).toLowerCase()));
  tokensExpected += tokens.length;
  tokensFound += hits.length;

  const flags = [
    violations.length === 0 ? 'contract-ok' : `contract-FAIL(${violations.length})`,
    tokens.length > 0 ? `tokens ${hits.length}/${tokens.length}` : 'tokens n/a',
    shouldFire ? '' : 'FIRED ON A NEGATIVE'
  ]
    .filter(Boolean)
    .join('  ');
  console.log(`${test.id.padEnd(24)} expect=${test.expect.padEnd(5)} skill "${parsed.draft.name}"  ${flags}`);
}

// ---- report ----
const firePrecision = drafts === 0 ? (expectedFires === 0 ? 1 : 0) : firedOnPositive / drafts;
const fireRecall = expectedFires === 0 ? 1 : firedOnPositive / expectedFires;
const contractRate = drafts === 0 ? 1 : contractValid / drafts;
const tokenRate = tokensExpected === 0 ? 1 : tokensFound / tokensExpected;

if (falseFires.length > 0) {
  console.log(`\n${'!'.repeat(78)}`);
  console.log(`FIRED ON ${falseFires.length} NEGATIVE CASE(S) — this is the failure mode that produced`);
  console.log('the library being deleted. Every one of these becomes a file that costs');
  console.log('context on every turn and that the model will follow.');
  for (const f of falseFires) {
    console.log(`  ${f.id}  "${f.draft.name}" — ${f.draft.description}`);
    console.log(`    fixture says: ${f.why || '(no reason recorded)'}`);
  }
  console.log(`${'!'.repeat(78)}`);
}

if (contractFailures.length > 0) {
  console.log('\n== contract violations (first reply, no retry) ==');
  for (const f of contractFailures) console.log(`  ${f.id}: ${f.violations.join('; ')}`);
}

console.log('\n== summary ==');
console.log(`cases                 ${cases.length} (${expectedFires} positive, ${cases.length - expectedFires} negative)`);
console.log(`skills produced       ${drafts} (${firedOnPositive} on positives, ${firedOnNegative} on negatives)`);
console.log(`unparseable replies   ${unparseable}`);
console.log(`fire precision        ${firePrecision.toFixed(3)}  floor ${FIRE_PRECISION_FLOOR}`);
console.log(`fire recall           ${fireRecall.toFixed(3)}  floor ${FIRE_RECALL_FLOOR}`);
console.log(`contract-valid rate   ${contractRate.toFixed(3)}  floor ${CONTRACT_VALID_FLOOR}  (${contractValid}/${drafts})`);
console.log(`content token rate    ${tokenRate.toFixed(3)}  floor ${CONTENT_TOKEN_FLOOR}  (${tokensFound}/${tokensExpected})`);

const violations = [];
if (firePrecision < FIRE_PRECISION_FLOOR) violations.push(`fire precision ${firePrecision.toFixed(3)} < ${FIRE_PRECISION_FLOOR}`);
if (fireRecall < FIRE_RECALL_FLOOR) violations.push(`fire recall ${fireRecall.toFixed(3)} < ${FIRE_RECALL_FLOOR}`);
if (contractRate < CONTRACT_VALID_FLOOR) violations.push(`contract-valid rate ${contractRate.toFixed(3)} < ${CONTRACT_VALID_FLOOR}`);
if (tokenRate < CONTENT_TOKEN_FLOOR) violations.push(`content token rate ${tokenRate.toFixed(3)} < ${CONTENT_TOKEN_FLOOR}`);
// An unparseable reply is not a soft signal: the shipped path retries once and then
// gives up, so a model that cannot emit the JSON shape produces nothing at all.
if (unparseable > 0) violations.push(`${unparseable} unparseable reply/replies`);

if (violations.length > 0) {
  console.error('\nFLOOR VIOLATIONS:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('\nALL FLOORS PASS');
