import type { ExecSettings, ModelSummary } from '../../shared/types';

// The run_command auto-approve policy, kept pure so it is unit-testable:
//
//   tier 1  static safe allowlist + the user's learned prefixes → run immediately
//   tier 2  everything else → a one-word LLM judge classification
//   tier 3  judge said unsafe/unsure (or failed) → manual approval card
//
// Chains (`&&`, `||`, `|`, `;`, newline) are split into segments that are each
// matched on their own — the whole command auto-runs only when EVERY segment
// clears an allowlist (a compound like `git status && rm -rf /` must never
// auto-run on the strength of its head). Any other shell metacharacter outside
// single quotes (redirects, substitution, background `&`, escapes) disqualifies
// tier 1 entirely, and a command word containing a path separator never matches
// (an allowlisted `git` must not admit `./git`).

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
  // Windows cmd.exe equivalents of common read-only probes.
  'dir',
  'where',
  'type',
  'cd',
  'echo',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'agent-browser'
]);

/** One chained command within a compound (or the whole thing when not chained). */
export interface ParsedSegment {
  /** Command word + subcommand when one is present (e.g. `git status`). */
  prefix: string;
  /** The candidate prefixes to match against an allowlist, shortest first. */
  candidates: string[];
}

export interface ParsedCommand {
  /** One entry per chained command; empty for a blank command. */
  segments: ParsedSegment[];
  /** A non-chaining shell metacharacter appeared outside single quotes → never tier 1. */
  hasShellMeta: boolean;
}

// Metacharacters that give a command shell semantics beyond "commands chained
// with plain arguments". Chain separators (&&, ||, |, ;, newline) are handled
// by the segment split instead. Backslash-escapes are treated as meta too —
// rare, and conservative is cheap.
const HARD_META_CHARS = new Set(['>', '<', '`', '$', '(', ')', '{', '}', '\\', '\r']);
// Inside double quotes only expansion characters stay live — `&`, `|`, `(` etc.
// are literal there, and flagging them threw every double-quoted URL/CSS selector
// (agent-browser's bread and butter) out of tier 1 and onto the judge.
const DQUOTE_META_CHARS = new Set(['$', '`', '\\']);

// A learnable subcommand must be the token immediately after the command word
// and look like a bare word. A URL, path, format string, or flag value
// (`--session yt-npc6`, `https://…`, `title=%(title)s`) must never end up in a
// learned prefix — those are one-shot values that will not match again.
const BARE_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

function makeSegment(tokens: string[]): ParsedSegment {
  const word = tokens[0] ?? '';
  const sub = tokens[1] && BARE_WORD.test(tokens[1]) ? tokens[1] : undefined;
  // Candidates are matched by exact string only, so `/usr/local/bin/foo` or `./git`
  // can be user-allowlisted verbatim but can never match an allowlisted bare `git`.
  const candidates = word ? (sub ? [word, `${word} ${sub}`] : [word]) : [];
  return { prefix: candidates[candidates.length - 1] ?? '', candidates };
}

/**
 * Quote-aware parse of a shell command string into allowlist-matchable segments.
 * Not a full shell parser — anything with shell semantics beyond "commands
 * chained with plain arguments" comes back `hasShellMeta` and is left to the judge.
 */
export function parseCommand(command: string): ParsedCommand {
  const segments: ParsedSegment[] = [];
  let tokens: string[] = [];
  let current = '';
  let inToken = false;
  let hasShellMeta = false;
  let quote: "'" | '"' | null = null;

  const endToken = (): void => {
    if (inToken) {
      tokens.push(current);
      current = '';
      inToken = false;
    }
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length) segments.push(makeSegment(tokens));
    tokens = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
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
      endToken();
      continue;
    }
    if (ch === ';' || ch === '\n') {
      endSegment();
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        i += 1;
        endSegment();
      } else hasShellMeta = true; // lone `&` backgrounds the command — not a chain
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') i += 1;
      endSegment(); // both `|` (pipe) and `||` (or) join two plain commands
      continue;
    }
    if (HARD_META_CHARS.has(ch)) hasShellMeta = true;
    current += ch;
    inToken = true;
  }
  if (quote) hasShellMeta = true; // unterminated quote — not a plain command
  endSegment();

  return { segments, hasShellMeta };
}

export interface Classification {
  /** 'run' = tier 1 (auto-run now); 'judge' = needs the LLM judge (tier 2). */
  tier: 'run' | 'judge';
  /**
   * What "Always allow" should persist: the learnable prefix of every segment not
   * already covered by an allowlist. Empty when the command has shell semantics
   * tier 1 can never match — learning a prefix there would change nothing, so the
   * approval card should not offer it.
   */
  prefixes: string[];
  hasShellMeta: boolean;
}

/** Decide whether a command may auto-run (tier 1) or must be judged. */
export function classify(command: string, settings: Pick<ExecSettings, 'allowlist'>): Classification {
  const parsed = parseCommand(command);
  if (parsed.hasShellMeta || !parsed.segments.length) {
    return { tier: 'judge', prefixes: [], hasShellMeta: parsed.hasShellMeta };
  }
  const user = new Set(settings.allowlist);
  const uncovered = parsed.segments.filter(
    (seg) => !seg.candidates.some((c) => STATIC_ALLOWLIST.has(c) || user.has(c))
  );
  const prefixes = [...new Set(uncovered.map((seg) => seg.prefix).filter(Boolean))];
  return { tier: uncovered.length ? 'judge' : 'run', prefixes, hasShellMeta: false };
}

/**
 * The one-shot classification prompt for the safety judge. Safety is judged
 * relative to the user's request when it is available — a download the user
 * asked for is expected; the same download out of nowhere is not.
 */
export function buildJudgePrompt(command: string, cwd: string, userIntent?: string): string {
  const intent = (userIntent ?? '').trim().slice(0, 800);
  return [
    'An AI assistant working on a request from its user wants to run a shell command on',
    "the user's machine (zsh on macOS/Linux, cmd.exe on Windows). Classify whether the",
    'command is safe to run without asking the user first. Reply with exactly one word',
    '— safe, unsafe, or unsure — optionally followed on the same line by a very short reason.',
    '',
    "- safe: the command plausibly serves the user's request and does not destroy data,",
    '  change system or account state, or install software the user did not ask for.',
    '  Reading files, fetching or downloading content, opening pages or apps, and',
    '  writing inside the working directory or a system temp folder are all safe when',
    "  the request calls for them. Sending the user's own files or data somewhere is",
    '  safe only when the request asks for exactly that.',
    '- unsafe: deletes or overwrites data unrelated to the request or outside the',
    '  working directory and temp folders, changes system or account state, sends local',
    '  files, secrets, or personal data anywhere the user did not ask for, installs',
    "  software unprompted, or clearly does not serve the user's request.",
    '- unsure: you cannot tell.',
    '',
    intent
      ? `The user's request the assistant is working on:\n${intent}`
      : "The user's request is not available — judge the command on its own.",
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
 * If that provider has no cheap-tier name, reuse the live chat model (or the
 * list default / first available) — never return null while authenticated models
 * exist, or complete() falls through to the built-in openai-codex constant and
 * fails with "No API key" for users signed in only to another provider (e.g. xAI).
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
  // No cheap-tier name in this provider's catalog (xAI grok-* etc.): stay on the
  // live chat model, then the app default, then any model we know is signed-in.
  if (currentModel && (!provider || currentModel.startsWith(`${provider}/`))) return currentModel;
  const fallback = pool.find((m) => m.isDefault) ?? pool[0] ?? models.find((m) => m.isDefault) ?? models[0];
  return fallback?.id ?? null;
}
