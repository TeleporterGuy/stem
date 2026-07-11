// Real-inference durable-memory extraction evaluation against an OpenAI-compatible
// endpoint. This is an explicit release gate rather than a unit test because it
// consumes model tokens and may send the synthetic fixture to a remote provider.
//
// Required:
//   STEM_MEMORY_EVAL_BASE_URL=http://127.0.0.1:1234/v1
//   STEM_MEMORY_EVAL_MODEL=model-id
// Optional: STEM_MEMORY_EVAL_API_KEY
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const baseUrl = process.env.STEM_MEMORY_EVAL_BASE_URL?.replace(/\/$/, '');
const model = process.env.STEM_MEMORY_EVAL_MODEL;
const apiKey = process.env.STEM_MEMORY_EVAL_API_KEY;
if (!baseUrl || !model) {
  console.error('Set STEM_MEMORY_EVAL_BASE_URL and STEM_MEMORY_EVAL_MODEL to run the real extraction gate.');
  process.exit(2);
}

const fixture = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/memory-extraction-golden.json'), 'utf8'));

/**
 * The gate has to grade the prompt that actually ships, so lift DISTILL_INSTRUCTIONS
 * straight out of distill.ts rather than keeping a paraphrase here that silently
 * drifts. Reading the source beats compiling it: the module pulls in the whole store
 * (node:sqlite, the embedder), none of which this script needs.
 */
function shippedInstructions() {
  const source = readFileSync(join(ROOT, 'src/main/recall/distill.ts'), 'utf8');
  const match = source.match(/export const DISTILL_INSTRUCTIONS = `([\s\S]*?)`;\n/);
  if (!match) throw new Error('DISTILL_INSTRUCTIONS not found in src/main/recall/distill.ts — update memory-eval.mjs');
  if (/\$\{/.test(match[1])) throw new Error('DISTILL_INSTRUCTIONS gained an interpolation — memory-eval.mjs cannot lift it verbatim');
  return match[1].replace(/\\`/g, '`');
}
const instructions = shippedInstructions();

function matches(claim, expected) {
  const text = String(claim.text ?? '').toLowerCase();
  return expected.tokens.every((token) => text.includes(token.toLowerCase()));
}

let extracted = 0;
let expectedTotal = 0;
let matched = 0;
let policyFailures = 0;
let usageFailures = 0;
for (const test of fixture.cases) {
  const known = test.known.map((f) => `- [fact:${f.id} source:${f.source}] ${f.text}`).join('\n');
  // v3: some cases carry an injected-facts block, mirroring the grading duty the
  // shipped distill pass rides on the same call (see gradableTurns in distill.ts).
  const usage = test.injectedFacts
    ? `\n\nInjected facts per assistant reply (grade these in factUsage):\n${test.injectedFacts}`
    : '';
  const prompt = `${instructions}\n\nToday's date: 2026-07-10.` +
    `${known ? `\n\nKnown facts:\n${known}` : ''}${usage}\n\nTranscript:\n${test.transcript}`;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) throw new Error(`${test.id}: HTTP ${response.status} ${await response.text()}`);
  const body = await response.json();
  const raw = body.choices?.[0]?.message?.content ?? '';
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  let claims = [];
  let factUsage = [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    claims = parsed.claims ?? [];
    factUsage = Array.isArray(parsed.factUsage) ? parsed.factUsage : [];
  } catch {
    policyFailures += 1;
    console.error(`${test.id}: invalid JSON`);
    continue;
  }

  // v3 usage grading: for each expected grade, the model must report exactly the
  // used subset of the listed fact ids for that message (set equality).
  for (const exp of test.expectedUsage ?? []) {
    const got = factUsage.find((u) => u.messageId === exp.messageId)?.usedFactIds ?? [];
    const gotSet = new Set(got);
    const ok = exp.usedFactIds.length === gotSet.size && exp.usedFactIds.every((id) => gotSet.has(id));
    if (!ok) {
      usageFailures += 1;
      console.error(`${test.id}: usage grade mismatch for message ${exp.messageId} — expected [${exp.usedFactIds}], got [${got}]`);
    }
  }
  extracted += claims.length;
  expectedTotal += test.expected.length;
  const used = new Set();
  for (const expected of test.expected) {
    const index = claims.findIndex((claim, i) => !used.has(i) && matches(claim, expected));
    if (index === -1) continue;
    used.add(index);
    matched += 1;
    const claim = claims[index];
    if (expected.sensitivity && claim.sensitivity !== expected.sensitivity) policyFailures += 1;
    if (expected.validUntil && !claim.validUntil) policyFailures += 1;
    if (expected.supersedes && !expected.supersedes.every((id) => claim.supersedesFactIds?.includes(id))) policyFailures += 1;
  }
  for (const forbidden of test.forbidden ?? []) {
    if (raw.includes(forbidden)) policyFailures += 1;
  }
  console.log(`${test.id}: ${claims.length} claim(s), ${used.size}/${test.expected.length} expected`);
}

const precision = extracted === 0 ? (expectedTotal === 0 ? 1 : 0) : matched / extracted;
const recall = expectedTotal === 0 ? 1 : matched / expectedTotal;
console.log(`precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} policyFailures=${policyFailures} usageFailures=${usageFailures}`);
if (precision < 0.95 || recall < 0.85 || policyFailures > 0 || usageFailures > 0) process.exit(1);
