// Scored skill-retrieval eval: ranks a synthetic skill library against a set of
// hand-written queries using REAL local-model inference (transformers.js, same
// catalog spec as the app) and prints recall@1/3/5 + MRR overall and per language
// pair. Exits 1 when any fixture floor is violated.
//
// This is a gate, not a unit test. A unit test with a fake embedder can only assert
// that the ranking code sorts what it is given; whether a Slovak sentence about
// lunch actually lands on `scrape-daily-lunch-menu` rather than
// `book-restaurant-table` is a property of the embedding model and of the
// descriptions the contract asks the model to write, and only real inference
// measures it. It is kept out of CI for the same reason recall-eval.mjs is: it
// downloads model weights on first run (cached in .embed-smoke-cache/, shared with
// scripts/embed-smoke.mjs and scripts/recall-eval.mjs).
//
//   npm run eval:skill-retrieval
//   node scripts/skill-retrieval-eval.mjs --skip-build --model multilingual-e5-base
//
// WHAT THIS DOES NOT MEASURE: the shipped ranker in src/server/skills/inject.ts blends
// a usage term into the score the way recall/inject.ts does for facts
// (`blended = cosine + SKILL_USAGE_WEIGHT·(usageRate − 0.5)`), and then reranks the
// survivors. Neither is modelled here. The usage term is a function of the user's own
// history, so including it would make the gate move whenever their habits move — and
// it cannot rescue a skill whose description does not match in the first place: a
// skill that never ranks is never injected, so it can never accumulate the usage that
// would lift it. Nor is the SKILL_MIN_COSINE inline gate applied; this scores the
// ORDER, not what survives the cut. What is left is the description-matching signal
// in isolation, which is the floor everything else is built on top of.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_DIR = join(ROOT, '.skills-build');

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const modelArg = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'multilingual-e5-small';

// ---- 1. compile the embedding catalog (same mechanism as recall-eval.mjs) ----
// Only embed-catalog.ts is needed, and it is pure data + string helpers whose only
// imports are type-only — so this compiles in isolation without dragging in
// node:sqlite or the embedder. Lifting the repo/dtype/prefixes from the shipping
// catalog rather than hardcoding them keeps the gate measuring the model the app
// actually uses.
if (!skipBuild) {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  const tsc = spawnSync(
    'npx',
    [
      'tsc', 'src/server/recall/embed-catalog.ts',
      '--outDir', '.skills-build',
      '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'es2022',
      '--skipLibCheck', '--esModuleInterop', '--rootDir', 'src'
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  writeFileSync(join(BUILD_DIR, 'package.json'), '{"type":"commonjs"}');
}

const require = createRequire(import.meta.url);
const catalog = require(join(BUILD_DIR, 'server', 'recall', 'embed-catalog.js'));

const { aggregate, checkFloors, formatViolation, scoreRanking } = await import('../tests/eval/score.mjs');

const fixture = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'skill-retrieval-golden.json'), 'utf8'));

// ---- 2. real inference ----
const spec = catalog.EMBED_CATALOG[modelArg];
if (!spec) {
  console.error(`unknown model '${modelArg}' — one of: ${Object.keys(catalog.EMBED_CATALOG).join(', ')}`);
  process.exit(1);
}
const { pipeline, env } = await import('@huggingface/transformers');
env.cacheDir = join(ROOT, '.embed-smoke-cache');
console.log(`loading ${spec.repo} (dtype ${spec.dtype})…`);
const t0 = Date.now();
const extractor = await pipeline('feature-extraction', spec.repo, { dtype: spec.dtype });
console.log(`model ready in ${Date.now() - t0} ms`);

async function embed(texts, kind) {
  const out = await extractor(catalog.applyPrefixes(spec, kind, texts), { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  return texts.map((_, i) => Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)));
}

function cosine(a, b) {
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  const m = Math.sqrt(ma) * Math.sqrt(mb);
  return m === 0 ? 0 : dot / m;
}

// ---- 3. index the library ----
// The indexed text is `${name}\n${description}` — the same string `skillVectorText`
// builds in src/server/skills/vectors.ts, which is what the shipped ranker actually
// embeds. The name carries signal of its own precisely because the contract forbids
// the description from restating it (`restatesName` in skills/contract.ts), so the
// two are complementary rather than redundant.
const skills = fixture.skills;
const skillVecs = await embed(skills.map((s) => `${s.name}\n${s.description}`), 'passage');
console.log(`indexed ${skills.length} skills`);

// ---- 4. rank ----
const rows = [];
const misses = [];
for (const q of fixture.queries) {
  const [qVec] = await embed([q.text], 'query');
  const ranked = skills
    .map((s, i) => ({ name: s.name, sim: cosine(qVec, skillVecs[i]) }))
    .sort((a, b) => b.sim - a.sim);
  const rankedNames = ranked.map((r) => r.name);
  const metrics = scoreRanking(rankedNames, [q.expectSlug]);
  rows.push({ tier: 'skills-description', langPair: q.langPair ?? 'en->en', metrics });
  if (metrics['recall@5'] === 0) misses.push({ q, got: ranked.slice(0, 3) });
  const at = rankedNames.indexOf(q.expectSlug);
  console.log(
    `${q.id.padEnd(4)} ${(q.langPair ?? 'en->en').padEnd(7)} rank ${String(at + 1).padStart(2)}  ` +
      `top="${ranked[0].name}" (${ranked[0].sim.toFixed(4)})  margin ${(ranked[0].sim - ranked[1].sim).toFixed(4)}`
  );
}

// ---- 5. report (same shape as recall-eval.mjs) ----
const agg = aggregate(rows);
const METRICS = ['recall@1', 'recall@3', 'recall@5', 'mrr'];
const fmt = (v) => v.toFixed(3);

console.log('\n== per tier ==');
console.log(['tier'.padEnd(20), 'n'.padStart(3), ...METRICS.map((m) => m.padStart(9))].join(' '));
for (const [tier, a] of Object.entries(agg.byTier)) {
  console.log([tier.padEnd(20), String(a.n).padStart(3), ...METRICS.map((m) => fmt(a[m]).padStart(9))].join(' '));
}

console.log('\n== per (tier, langPair) ==');
for (const [tier, pairs] of Object.entries(agg.byTierLangPair)) {
  for (const [lp, a] of Object.entries(pairs)) {
    console.log(
      [`${tier}/${lp}`.padEnd(28), String(a.n).padStart(3), ...METRICS.map((m) => fmt(a[m]).padStart(9))].join(' ')
    );
  }
}

if (misses.length > 0) {
  console.log('\n== misses (recall@5 = 0) ==');
  for (const { q, got } of misses) {
    console.log(`${q.id.padEnd(4)} "${q.text}" → expected ${q.expectSlug}, got [${got.map((g) => g.name).join(', ')}]`);
  }
}

// ---- 6. floors ----
const violations = checkFloors(agg, fixture.floors);
if (violations.length > 0) {
  console.error('\nFLOOR VIOLATIONS:');
  for (const v of violations) {
    console.error(`  ${formatViolation(v, fmt)}`);
  }
} else {
  console.log('\nALL FLOORS PASS');
}

// Release the ORT session before the process ends. Left to garbage collection it
// aborts on teardown ("mutex lock failed") — the same ORT fragility documented in
// embed-catalog.ts — and a SIGABRT would replace this run's verdict with exit 134,
// making a passing gate look like a crash and a failing one indistinguishable.
// `process.exitCode` rather than `process.exit()`: exiting immediately cuts the
// dispose short and the abort comes back.
await extractor.dispose();
process.exitCode = violations.length > 0 ? 1 : 0;
