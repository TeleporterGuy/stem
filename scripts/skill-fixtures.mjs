// Fixture harvester for the skill authoring gate. Reads pi's own session JSONL out
// of the Electron userData dir, reconstructs turns from it, and writes candidate
// cases to tests/fixtures/skill-authoring-golden.json for a human to label.
//
// This is a harvester, not a labeller. Whether a turn "contains a reusable
// procedure" is the exact judgement scripts/skill-author-eval.mjs is measuring, so
// a script that decided it would be grading itself. Candidates are therefore
// selected MECHANICALLY (by tool count, the same signal the shipped fire gate
// uses) and written out with `"expect": "TODO"`; the operator fills in expect/why/
// expectTokens by reading them. Negatives are different — "zero tool calls" is a
// definition, not a judgement — so those are labelled from the rule itself and the
// rule is recorded in `why`.
//
//   npm run fixtures:skills
//   STEM_SESSIONS_DIR=/path/to/sessions node scripts/skill-fixtures.mjs
//
// PRIVACY: the input is the user's real conversations and the output lands inside
// the repo. Tool results are truncated exactly as the runtime truncates them, the
// injected <!--stem:context--> block (which carries recall facts about the user) is
// stripped, and encrypted-secret envelopes are dropped — but nothing here can tell
// that a remaining line is fine to publish. The script says so, loudly, on exit.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Mirrored from src/server/pi/normalize.ts. The fixture has to look like what
// authorSkill() will actually be handed at runtime, so the caps must match; if
// they change there, change them here.
const TRACE_ARGS_MAX_CHARS = 600;
const TRACE_RESULT_MAX_CHARS = 2_000;
const TRACE_TURN_MAX_CHARS = 24_000;
const SECRET_ENVELOPE_KEY = '__stemenc__'; // src/server/pi/protocol.ts

// Selection rules. POSITIVE_MIN_TOOLS matches the backtest in SKILLS-REBUILD.md
// (>=4 tool calls covers 12.2% of turns and subsumes every error->recovery turn).
const POSITIVE_MIN_TOOLS = 4;
const NEGATIVE_MAX_TOOLS = 1; // zero-tool chit-chat and single-lookup turns
const MAX_NEGATIVES = 24; // ~400 zero-tool turns exist; a stride sample is plenty
const MIN_USER_TEXT = 8; // a turn with no real user prose isn't a case

const OUT_PATH = join(ROOT, 'tests/fixtures/skill-authoring-golden.json');

/** Where Electron puts userData for this app. productName is Stem (electron-builder.yml); dev runs use package.json `name`. */
function sessionDirCandidates() {
  const override = process.env.STEM_SESSIONS_DIR;
  if (override) return [override];
  const names = ['Stem', 'stem'];
  const bases =
    process.platform === 'darwin'
      ? names.map((n) => join(homedir(), 'Library', 'Application Support', n))
      : process.platform === 'win32'
        ? names.map((n) => join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), n))
        : names.map((n) => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), n));
  return bases.map((b) => join(b, 'pi-home', 'sessions'));
}

function resolveSessionsDir() {
  const candidates = sessionDirCandidates();
  const found = candidates.find((d) => existsSync(d));
  if (!found) {
    console.error('No sessions directory found. Looked in:');
    for (const c of candidates) console.error(`  ${c}`);
    console.error('Set STEM_SESSIONS_DIR to point at one.');
    process.exit(2);
  }
  return found;
}

/** Same shape as normalize.ts `truncate`, so fixture text matches runtime text byte for byte. */
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/** Port of normalize.ts `traceArgs`: JSON, truncated, secrets dropped whole. */
function traceArgs(args) {
  if (!args || typeof args !== 'object') return undefined;
  let json;
  try {
    json = JSON.stringify(args);
  } catch {
    return undefined;
  }
  if (!json || json === '{}') return undefined;
  if (json.includes(SECRET_ENVELOPE_KEY)) return undefined;
  return truncate(json, TRACE_ARGS_MAX_CHARS);
}

/**
 * Unwrap the MCP router's invoke_tool meta-tool, the way toolCallActivity does in
 * normalize.ts — a skill has to be able to name the real tool, not the router.
 */
function unwrapTool(name, args) {
  if (name === 'invoke_tool' && typeof args?.tool === 'string') {
    return { name: args.tool, args: (args.args && typeof args.args === 'object' ? args.args : undefined) };
  }
  return { name, args };
}

/** Text content of a message's blocks, in order. */
function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * Strip Stem's injected per-turn context. Everything before <!--/stem:context--> is
 * standing instructions plus recalled facts about the user — never something they
 * typed, and the most sensitive text in the file.
 */
function userProse(raw) {
  const end = raw.lastIndexOf('<!--/stem:context-->');
  const text = end === -1 ? raw : raw.slice(end + '<!--/stem:context-->'.length);
  return text.trim();
}

/** Read one session file into an ordered list of {role, content, ...} messages. */
function readSession(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // a partially-flushed tail line; skip it
    }
    if (obj?.type === 'message' && obj.message) out.push(obj.message);
  }
  return out;
}

/**
 * Reconstruct turns: a turn opens on a user message and closes at the next one.
 * Tool calls come from assistant `toolCall` blocks; their outcomes come from the
 * `toolResult` messages that follow, joined on toolCallId — which is where the real
 * `isError` flag lives (nothing infers errors from result text here).
 *
 * The per-turn budget is applied here for the same reason the per-entry caps are:
 * a fixture that carries evidence production would have dropped grades a prompt
 * nobody ships. A long browser turn blows through 24k around the twentieth call,
 * and everything after it reaches the author as a bare tool name — so the gate
 * has to see it that way too. Charged in traversal order (args at the call, the
 * result when it lands), which matches the runtime for the one-call-at-a-time
 * traces this reads; a model that emitted several calls in one message would
 * charge them slightly earlier here than the runtime does.
 */
function turnsOf(messages, sessionId) {
  const turns = [];
  let current = null;
  const byCallId = new Map();

  const close = () => {
    if (current) turns.push(current);
    current = null;
  };

  for (const m of messages) {
    if (m.role === 'user') {
      close();
      const prose = userProse(blockText(m.content));
      current = { sessionId, index: turns.length, userText: prose, assistantText: '', trace: [], traceChars: 0 };
      byCallId.clear();
      continue;
    }
    if (!current) continue;
    if (m.role === 'assistant') {
      const text = blockText(m.content);
      if (text.trim()) current.assistantText += (current.assistantText ? '\n' : '') + text.trim();
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== 'toolCall') continue;
        const { name, args } = unwrapTool(b.name, b.arguments);
        const entry = { name: name ?? 'tool' };
        const rendered = current.traceChars < TRACE_TURN_MAX_CHARS ? traceArgs(args) : undefined;
        if (rendered) entry.args = rendered;
        current.traceChars += rendered?.length ?? 0;
        current.trace.push(entry);
        if (typeof b.id === 'string') byCallId.set(b.id, entry);
      }
      continue;
    }
    if (m.role === 'toolResult') {
      const entry = byCallId.get(m.toolCallId);
      if (!entry) continue;
      if (m.isError === true) entry.isError = true;
      const text = blockText(m.content).trim();
      // A failure keeps its result whatever the budget says: the error text is the
      // dead end a skill exists to record. Same exemption as the runtime's.
      if (text && (entry.isError || current.traceChars < TRACE_TURN_MAX_CHARS)) {
        entry.result = truncate(text, TRACE_RESULT_MAX_CHARS);
        current.traceChars += entry.result.length;
      }
    }
  }
  close();
  return turns;
}

/** Deterministic evenly-spaced sample, so re-running the harvester is stable. */
function stride(items, max) {
  if (items.length <= max) return items;
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)]);
}

// ---- harvest ----
const dir = resolveSessionsDir();
const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
console.log(`reading ${files.length} session logs from ${dir}`);

const allTurns = [];
for (const f of files) {
  try {
    allTurns.push(...turnsOf(readSession(join(dir, f)), f.replace(/\.jsonl$/, '')));
  } catch (error) {
    console.warn(`  skipped ${f}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const usable = allTurns.filter((t) => t.userText.length >= MIN_USER_TEXT);
const toolCounts = usable.map((t) => t.trace.length);
const errorTurns = usable.filter((t) => t.trace.some((e) => e.isError)).length;

const positiveTurns = usable.filter((t) => t.trace.length >= POSITIVE_MIN_TOOLS);
const zeroToolTurns = usable.filter((t) => t.trace.length === 0);
const singleLookupTurns = usable.filter((t) => t.trace.length >= 1 && t.trace.length <= NEGATIVE_MAX_TOOLS);
const negativeTurns = stride([...zeroToolTurns, ...singleLookupTurns], MAX_NEGATIVES);

// Session files are named `<iso-timestamp>_<uuid>.jsonl`; the uuid half is the
// part that identifies the session, so ids stay stable and distinct.
const caseId = (t, tag) => `${tag}-${(t.sessionId.split('_').pop() ?? t.sessionId).slice(0, 8)}-${t.index}`;

const positives = positiveTurns.map((t) => ({
  id: caseId(t, 'pos'),
  // "TODO" is not a label — the author eval refuses to run until every one of
  // these is resolved to "skill" or "none" by a human who read the turn.
  expect: 'TODO',
  why: '',
  toolCount: t.trace.length,
  hadError: t.trace.some((e) => e.isError),
  // Strings that MUST appear in the authored body — the command, flag, or URL that
  // actually worked. Fill these in; an empty list scores as no content signal.
  expectTokens: [],
  input: { userText: t.userText, assistantText: t.assistantText, trace: t.trace }
}));

const negatives = negativeTurns.map((t) => ({
  id: caseId(t, 'neg'),
  expect: 'none',
  why:
    t.trace.length === 0
      ? 'zero tool calls — nothing was done that could be written down as a procedure'
      : 'a single tool call — the skill would be a restatement of one lookup',
  toolCount: t.trace.length,
  hadError: false,
  input: { userText: t.userText, assistantText: t.assistantText, trace: t.trace }
}));

mkdirSync(join(ROOT, 'tests/fixtures'), { recursive: true });
writeFileSync(
  OUT_PATH,
  `${JSON.stringify(
    {
      _comment:
        'Harvested from real session logs by scripts/skill-fixtures.mjs. Positives carry expect:"TODO" ' +
        'and must be labelled by hand ("skill" or "none") with a why and, for "skill", the expectTokens ' +
        'that have to survive into the body. Negatives are labelled from the selection rule itself. ' +
        'REVIEW THIS FILE FOR PRIVATE CONTENT BEFORE COMMITTING IT.',
      harvestedAt: new Date().toISOString(),
      source: { sessions: files.length, turns: usable.length, positiveMinTools: POSITIVE_MIN_TOOLS },
      positives,
      negatives
    },
    null,
    2
  )}\n`
);

// ---- report ----
const histogram = new Map();
for (const n of toolCounts) {
  const bucket = n === 0 ? '0' : n === 1 ? '1' : n < 4 ? '2-3' : n < 6 ? '4-5' : '6+';
  histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
}

console.log(`\n== corpus ==`);
console.log(`sessions            ${files.length}`);
console.log(`turns reconstructed ${allTurns.length}`);
console.log(`turns with prose    ${usable.length}`);
console.log(`turns with an error ${errorTurns}`);
console.log(`\n== tool calls per turn ==`);
for (const bucket of ['0', '1', '2-3', '4-5', '6+']) {
  const n = histogram.get(bucket) ?? 0;
  const pct = usable.length === 0 ? 0 : (100 * n) / usable.length;
  console.log(`${bucket.padEnd(5)} ${String(n).padStart(4)}  ${pct.toFixed(1)}%`);
}
console.log(`\n== written ==`);
console.log(`positives (>=${POSITIVE_MIN_TOOLS} tools, need labels) ${positives.length}`);
console.log(`negatives (<=${NEGATIVE_MAX_TOOLS} tools, auto-labelled) ${negatives.length}` +
  ` (sampled from ${zeroToolTurns.length + singleLookupTurns.length})`);

console.log(`\n${'!'.repeat(78)}`);
console.log(`WROTE ${OUT_PATH}`);
console.log('');
console.log('  This file contains excerpts of REAL conversations — user prose, tool');
console.log('  arguments, and tool output. Read it before you commit it, and redact');
console.log('  anything you would not publish. Truncation is not redaction.');
console.log('');
console.log(`  ${positives.length} positive case(s) carry expect:"TODO". Open the file and decide,`);
console.log('  per case, whether that turn should produce a skill ("skill") or not');
console.log('  ("none"), write the reason into "why", and for "skill" list the');
console.log('  expectTokens — the exact command/flag/URL that has to survive into the');
console.log('  body. scripts/skill-author-eval.mjs refuses to run while any TODO remains.');
console.log(`${'!'.repeat(78)}`);
