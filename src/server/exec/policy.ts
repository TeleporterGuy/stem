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
// quotes (redirects, substitution, background `&`, escapes) disqualifies tier 1
// entirely, and a command word containing a path separator never matches (an
// allowlisted `git` must not admit `./git`).
//
// The parse is PLATFORM-SPECIFIC because the two host shells disagree about
// quoting, and a parser that models the wrong one hands out tier 1 for commands
// the shell will happily split. See WINDOWS_HARD_META below.

/** Read-only probes that mean the same thing on both host shells. */
const SHARED_ALLOWLIST = ['rg', 'git status', 'git log', 'git diff', 'git show', 'git branch', 'agent-browser'];

/** POSIX (zsh) read-only probes. */
const POSIX_ALLOWLIST = [
  'ls',
  'cat',
  'pwd',
  'head',
  'tail',
  'wc',
  'grep',
  'find',
  'which',
  'file',
  'stat',
  'date'
];

/**
 * cmd.exe equivalents. Deliberately NOT merged into one cross-platform set: the
 * POSIX names do not exist under cmd (they would auto-run straight into "not
 * recognized"), and `dir`/`type`/`echo` must not widen the zsh tier-1 surface
 * for a platform that never sees them.
 */
const WINDOWS_ALLOWLIST = ['dir', 'type', 'where', 'echo', 'cd'];

function staticAllowlist(platform: NodeJS.Platform): Set<string> {
  return new Set([...SHARED_ALLOWLIST, ...(platform === 'win32' ? WINDOWS_ALLOWLIST : POSIX_ALLOWLIST)]);
}

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
const POSIX_HARD_META = new Set(['>', '<', '`', '$', '(', ')', '{', '}', '\\', '\r']);
// Inside double quotes only expansion characters stay live — `&`, `|`, `(` etc.
// are literal there, and flagging them threw every double-quoted URL/CSS selector
// (agent-browser's bread and butter) out of tier 1 and onto the judge.
const POSIX_DQUOTE_META = new Set(['$', '`', '\\']);

// cmd.exe is not zsh, and the differences are exactly the ones that decide
// whether a command can smuggle a second command past tier 1:
//   '   NOT a quote character. `cat 'a & whoami & rem '` reads as protected to a
//       POSIX parser, but cmd sees the bare `&` and runs whoami. Hard meta, and
//       single-quote *regions* are not honoured at all (see parseCommand).
//   %   %VAR% expands before the line is parsed, so a variable holding `& …`
//       injects a command. Hard meta.
//   ^   cmd's escape character — `^&` hides a separator from a naive scan.
//   \   NOT special: it is the path separator. Treating it as meta would push
//       every `type C:\…` onto the judge and make the Windows allowlist useless.
//   $ ` are ordinary characters under cmd; ( ) { } still group/parse, so they stay.
const WINDOWS_HARD_META = new Set(['>', '<', '(', ')', '{', '}', "'", '%', '^', '\r']);
// Double quotes in cmd suppress separators but NOT %VAR% expansion.
const WINDOWS_DQUOTE_META = new Set(['%']);

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
 *
 * `platform` selects which shell's quoting rules to model; it must match the
 * shell `shellInvocation()` will actually spawn, or tier 1 is decided against a
 * grammar the host does not use.
 */
export function parseCommand(command: string, platform: NodeJS.Platform = process.platform): ParsedCommand {
  const win = platform === 'win32';
  const hardMeta = win ? WINDOWS_HARD_META : POSIX_HARD_META;
  const dquoteMeta = win ? WINDOWS_DQUOTE_META : POSIX_DQUOTE_META;
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
        if (dquoteMeta.has(ch)) hasShellMeta = true;
        current += ch;
      }
      inToken = true;
      continue;
    }
    // Under cmd.exe `'` opens nothing — it falls through to the hard-meta check
    // below, so a single-quoted region can never hide a separator.
    if (ch === '"' || (ch === "'" && !win)) {
      quote = ch as "'" | '"';
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
    if (hardMeta.has(ch)) hasShellMeta = true;
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
export function classify(
  command: string,
  settings: Pick<ExecSettings, 'allowlist'>,
  platform: NodeJS.Platform = process.platform
): Classification {
  const parsed = parseCommand(command, platform);
  if (parsed.hasShellMeta || !parsed.segments.length) {
    return { tier: 'judge', prefixes: [], hasShellMeta: parsed.hasShellMeta };
  }
  const user = new Set(settings.allowlist);
  const allowed = staticAllowlist(platform);
  const uncovered = parsed.segments.filter(
    (seg) => !seg.candidates.some((c) => allowed.has(c) || user.has(c))
  );
  const prefixes = [...new Set(uncovered.map((seg) => seg.prefix).filter(Boolean))];
  return { tier: uncovered.length ? 'judge' : 'run', prefixes, hasShellMeta: false };
}

/** How to describe the host shell to the judge — one shell, the one that will run. */
export function hostShellLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'a Windows machine, under cmd.exe' : "the user's machine, under zsh";
}

/**
 * The one-shot classification prompt for the safety judge. Safety is judged
 * relative to the user's request when it is available — a download the user
 * asked for is expected; the same download out of nowhere is not.
 *
 * The prompt names the one shell that will actually run the command: what is
 * destructive in cmd is not what is destructive in zsh, and asking about both
 * at once only invites the model to hedge.
 */
export function buildJudgePrompt(
  command: string,
  cwd: string,
  userIntent?: string,
  platform: NodeJS.Platform = process.platform
): string {
  const intent = (userIntent ?? '').trim().slice(0, 800);
  return [
    `An AI assistant working on a request from its user wants to run a shell command on`,
    `${hostShellLabel(platform)}. Classify whether the`,
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

// Cheap-model markers, in preference order, for the auto judge pick. Names only —
// ModelSummary carries no price or tier, so this is the whole signal there is.
const CHEAP_MARKERS = ['haiku', 'mini', 'nano', 'flash', 'lite', 'spark', 'fast', 'small', 'turbo'];

/**
 * Resolve the judge model: the explicit setting wins; otherwise the
 * cheapest-looking model of the current provider (Anthropic → Haiku-class, etc.).
 *
 * When that provider publishes no cheap-tier name, fall back to a model we know
 * is signed in rather than null: null makes complete() use its built-in
 * openai-codex default, which fails with "No API key" for anyone signed in only
 * to another provider. The judge then runs on the chat's own model — correct but
 * not cheap, which is why Settings says so rather than promising "cheapest".
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
  // `provider` is derived from currentModel whenever there is one, so this is
  // already a same-provider pick; pool/models only matter when there is not.
  return currentModel ?? pool.find((m) => m.isDefault)?.id ?? pool[0]?.id ?? null;
}
