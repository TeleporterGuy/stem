// Pure policy helpers for the security gate.
// Keep this file free of Pi UI / complete() so it stays easy to reason about.
//
// Shell grammar: bash (POSIX). Use this on Windows when the host shell is bash
// (Git Bash / MSYS / WSL), NOT cmd.exe.

/** Seed allowlist — read-mostly probes. Keep narrow. */
export const STATIC_ALLOWLIST = new Set([
  'ls',
  'pwd',
  'cat',
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
  'git branch'
]);

export interface ParsedSegment {
  /** Best learnable prefix, e.g. "git status" or "npm". */
  prefix: string;
  /** Match candidates, shortest first: ["git", "git status"]. */
  candidates: string[];
}

export interface ParsedCommand {
  segments: ParsedSegment[];
  /** True when shell semantics beyond plain chains appear → never tier 1. */
  hasShellMeta: boolean;
}

const HARD_META = new Set(['>', '<', '`', '$', '(', ')', '{', '}', '\\', '\r']);
const DQUOTE_META = new Set(['$', '`', '\\']);
const BARE_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

function makeSegment(tokens: string[]): ParsedSegment {
  const word = tokens[0] ?? '';
  const sub = tokens[1] && BARE_WORD.test(tokens[1]) ? tokens[1] : undefined;
  // Path-ish command words never match a bare allowlisted name.
  const candidates = word ? (sub ? [word, `${word} ${sub}`] : [word]) : [];
  return { prefix: candidates[candidates.length - 1] ?? '', candidates };
}

/** Quote-aware bash parse into chain segments. Not a full shell parser. */
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
        if (DQUOTE_META.has(ch)) hasShellMeta = true;
        current += ch;
      }
      inToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
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
      } else hasShellMeta = true; // background
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') i += 1;
      endSegment();
      continue;
    }
    if (HARD_META.has(ch)) hasShellMeta = true;
    current += ch;
    inToken = true;
  }
  if (quote) hasShellMeta = true;
  endSegment();

  return { segments, hasShellMeta };
}

export interface Classification {
  /** 'run' = tier 1 auto-allow; 'judge' = needs LLM / user. */
  tier: 'run' | 'judge';
  /** Prefixes "Always allow" should persist (uncovered segments only). */
  prefixes: string[];
  hasShellMeta: boolean;
}

export function classify(command: string, userAllowlist: string[]): Classification {
  const parsed = parseCommand(command);
  if (parsed.hasShellMeta || !parsed.segments.length) {
    return { tier: 'judge', prefixes: [], hasShellMeta: parsed.hasShellMeta };
  }
  const user = new Set(userAllowlist);
  const uncovered = parsed.segments.filter(
    (seg) => !seg.candidates.some((c) => STATIC_ALLOWLIST.has(c) || user.has(c))
  );
  const prefixes = [...new Set(uncovered.map((s) => s.prefix).filter(Boolean))];
  return {
    tier: uncovered.length ? 'judge' : 'run',
    prefixes,
    hasShellMeta: false
  };
}

/** One-shot judge prompt — adapted from Stem; shell labeled for Windows bash. */
export function buildJudgePrompt(command: string, cwd: string, userIntent?: string): string {
  const intent = (userIntent ?? '').trim().slice(0, 800);
  return [
    'An AI assistant working on a request from its user wants to run a shell command on',
    "the user's Windows machine, under bash (Git Bash / MSYS / WSL bash — not cmd.exe).",
    'Classify whether the command is safe to run without asking the user first.',
    'Reply with exactly one word — safe, unsafe, or unsure — optionally followed on the',
    'same line by a very short reason.',
    '',
    "- safe: the command plausibly serves the user's request and does not destroy data,",
    '  change system or account state, or install software the user did not ask for.',
    '  Reading files, fetching or downloading content, and writing inside the working',
    '  directory or a system temp folder are safe when the request calls for them.',
    "- unsafe: deletes or overwrites data unrelated to the request or outside the",
    '  working directory and temp folders, changes system or account state, sends local',
    '  files/secrets anywhere the user did not ask for, installs software unprompted,',
    "  or clearly does not serve the user's request.",
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

/** Fail-safe parse: unknown text → unsure. Test unsafe before safe. */
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
