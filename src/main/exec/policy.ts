import type { ExecSettings, ModelSummary } from '../../shared/types';

// The run_command auto-approve policy, kept pure so it is unit-testable:
//
//   tier 1  static safe allowlist + the user's learned prefixes → run immediately
//   tier 2  everything else → a one-word LLM judge classification
//   tier 3  judge said unsafe/unsure (or failed) → manual approval card
//
// Tier-1 matching is deliberately conservative: any shell metacharacter outside
// single quotes disqualifies the command (a compound like `git status && rm -rf /`
// must never auto-run on the strength of its head), and a command word containing
// a path separator never matches (an allowlisted `git` must not admit `./git`).

/** Commands that are read-only or clearly harmless; matched against the parsed prefix. */
const STATIC_ALLOWLIST = new Set([
  'ls',
  'cat',
  'pwd',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'which',
  'file',
  'stat',
  'date',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'agent-browser'
]);

export interface ParsedCommand {
  /** Command word + first non-flag subcommand (e.g. `git status`), or just the command word. */
  prefix: string;
  /** The candidate prefixes to match against an allowlist, shortest first. */
  candidates: string[];
  /** A shell metacharacter appeared outside single quotes → never tier 1. */
  hasShellMeta: boolean;
}

// Metacharacters that give a "single command" additional shell semantics.
// Backslash-escapes are treated as meta too — rare, and conservative is cheap.
const META_CHARS = new Set([';', '&', '|', '>', '<', '`', '$', '(', ')', '{', '}', '\\', '\n', '\r']);
// Inside double quotes only expansion characters stay live — `&`, `|`, `(` etc.
// are literal there, and flagging them threw every double-quoted URL/CSS selector
// (agent-browser's bread and butter) out of tier 1 and onto the judge.
const DQUOTE_META_CHARS = new Set(['$', '`', '\\']);

/**
 * Quote-aware parse of a shell command string into allowlist-matchable prefixes.
 * Not a full shell parser — anything with shell semantics beyond "one command
 * with plain arguments" comes back `hasShellMeta` and is left to the judge.
 */
export function parseCommandPrefix(command: string): ParsedCommand {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let hasShellMeta = false;
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      inToken = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else {
        if (DQUOTE_META_CHARS.has(ch)) hasShellMeta = true;
        current += ch;
      }
      inToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    if (META_CHARS.has(ch)) hasShellMeta = true;
    current += ch;
    inToken = true;
  }
  if (quote) hasShellMeta = true; // unterminated quote — not a plain command
  if (inToken) tokens.push(current);

  const word = tokens[0] ?? '';
  const sub = tokens.slice(1).find((t) => t && !t.startsWith('-'));
  // Candidates are matched by exact string only, so `/usr/local/bin/foo` or `./git`
  // can be user-allowlisted verbatim but can never match an allowlisted bare `git`.
  const candidates: string[] = [];
  if (word) {
    candidates.push(word);
    if (sub) candidates.push(`${word} ${sub}`);
  }
  const prefix = candidates[candidates.length - 1] ?? '';
  return { prefix, candidates, hasShellMeta };
}

export interface Classification {
  /** 'run' = tier 1 (auto-run now); 'judge' = needs the LLM judge (tier 2). */
  tier: 'run' | 'judge';
  prefix: string;
  hasShellMeta: boolean;
}

/** Decide whether a command may auto-run (tier 1) or must be judged. */
export function classify(command: string, settings: Pick<ExecSettings, 'allowlist'>): Classification {
  const parsed = parseCommandPrefix(command);
  if (parsed.hasShellMeta || !parsed.candidates.length) {
    return { tier: 'judge', prefix: parsed.prefix, hasShellMeta: parsed.hasShellMeta };
  }
  const user = new Set(settings.allowlist);
  const allowed = parsed.candidates.some((c) => STATIC_ALLOWLIST.has(c) || user.has(c));
  return { tier: allowed ? 'run' : 'judge', prefix: parsed.prefix, hasShellMeta: false };
}

/** The one-shot classification prompt for the safety judge. */
export function buildJudgePrompt(command: string, cwd: string): string {
  return [
    'Classify whether this shell command is safe to run automatically on the user\'s',
    'macOS machine, without asking them. Reply with exactly one word — safe, unsafe,',
    'or unsure — optionally followed on the same line by a very short reason.',
    '',
    '- safe: read-only, or writes only inside its own working directory in a clearly harmless way.',
    '- unsafe: deletes or overwrites data outside its working directory, changes system or',
    '  account state, sends data to the network in a way the user may not expect, installs',
    '  software, or has ambiguous destructive potential.',
    '- unsure: you cannot tell.',
    '',
    `Working directory: ${cwd}`,
    `Command: ${command}`
  ].join('\n');
}

export interface JudgeVerdict {
  verdict: 'safe' | 'unsafe' | 'unsure';
  reason?: string;
}

/**
 * Parse the judge's reply. Order matters ("unsafe" contains "safe"); anything
 * unrecognized escalates as `unsure` — the fail-safe direction.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const firstLine = (text ?? '').trim().split('\n')[0] ?? '';
  const lower = firstLine.toLowerCase();
  const verdict = /\bunsafe\b/.test(lower)
    ? 'unsafe'
    : /\bunsure\b/.test(lower)
      ? 'unsure'
      : /\bsafe\b/.test(lower)
        ? 'safe'
        : 'unsure';
  const reason = firstLine
    .replace(/^[^a-zA-Z]*(unsafe|unsure|safe)\b[\s:,.—–-]*/i, '')
    .trim();
  return reason ? { verdict, reason } : { verdict };
}

// Cheap-model markers, in preference order, for the auto judge pick.
const CHEAP_MARKERS = ['haiku', 'mini', 'nano', 'flash', 'lite', 'spark'];

/**
 * Resolve the judge model: the explicit setting wins; otherwise pick the
 * cheapest-looking model of the current provider (Anthropic → Haiku-class, etc.).
 * Returns null when nothing better is known — complete() then uses its default.
 */
export function resolveJudgeModel(
  settings: Pick<ExecSettings, 'judgeModel'>,
  models: ModelSummary[],
  currentModel: string | null
): string | null {
  if (settings.judgeModel) return settings.judgeModel;
  const provider = currentModel?.split('/')[0] ?? models.find((m) => m.isDefault)?.provider ?? null;
  const pool = provider ? models.filter((m) => m.provider === provider) : models;
  for (const marker of CHEAP_MARKERS) {
    const hit = pool.find((m) => m.id.toLowerCase().includes(marker));
    if (hit) return hit.id;
  }
  return null;
}
