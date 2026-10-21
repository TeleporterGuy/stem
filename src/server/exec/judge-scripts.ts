import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';

// The files a command runs, read so the safety judge can see the code.
//
// Without this the judge saw `python prepare.py` and nothing else: a script
// the assistant had just written in its own scratch folder was unknown code,
// and the judge refused it ("runs an uninspected script") while passing the
// very same code sent inline as a heredoc. Showing the file judges it the way
// a typed command is judged — by what it does, not by where it lives — so
// work in scratch goes through and a script that does something not allowed
// is refused exactly as its commands would be.
//
// Only files the assistant may read itself (the exec read roots): the judge
// prompt goes to the same provider the chat does, and a path elsewhere is not
// something to read on the agent's say-so. What the judge saw is fingerprinted
// and checked again just before the command starts, so a file rewritten in
// between (a parallel write) is refused instead of run unseen.

/** Per file, and how many files: one prompt has to stay a quick judge call. */
export const SCRIPT_MAX_CHARS = 16_000;
const MAX_SCRIPTS = 3;

const SCRIPT_EXT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|mts|rb|pl|php|lua|r|ps1|bat|cmd)$/i;
const INTERPRETERS = new Set([
  'python', 'python3', 'node', 'bash', 'sh', 'zsh', 'ruby', 'perl', 'php', 'lua', 'deno', 'bun', 'tsx', 'ts-node',
  'pwsh', 'powershell', 'Rscript', 'source', '.'
]);

export interface JudgedScript {
  /** As the command names it. */
  name: string;
  /** Where that name pointed from the command's cwd, before links were followed. */
  named: string;
  path: string;
  content: string;
  truncated: boolean;
  /** Fingerprint of the whole file when it was read. */
  hash: string;
}

/** Words of a shell command, quotes stripped. A reader for path candidates, not a shell parser. */
function words(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s;&|<>()`]+)/g)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out.filter(Boolean);
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

async function readOne(path: string): Promise<{ content: string; truncated: boolean; hash: string } | null> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    // quiet: not a readable file — nothing to show, so the judge sees the command alone.
    return null;
  }
  try {
    const info = await fh.stat();
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return null;
    const bytes = await fh.readFile();
    // Binary is not a script anyone can read.
    if (bytes.subarray(0, 8000).includes(0)) return null;
    const text = bytes.toString('utf8');
    return {
      content: text.slice(0, SCRIPT_MAX_CHARS),
      truncated: text.length > SCRIPT_MAX_CHARS,
      hash: createHash('sha256').update(bytes).digest('hex')
    };
  } finally {
    // quiet: a read-only handle that fails to close has nothing to lose.
    await fh.close().catch(() => undefined);
  }
}

/**
 * The script files `command` runs from `cwd`: a word ending in a script
 * extension, or the word after an interpreter, that resolves to a regular file
 * inside one of `roots`. At most three, in command order.
 */
export async function scriptsForJudge(
  command: string,
  cwd: string,
  roots: string[]
): Promise<JudgedScript[] & { notShown?: number }> {
  const ws = words(command);
  const candidates: string[] = [];
  ws.forEach((w, i) => {
    const prev = i > 0 ? basename(ws[i - 1]!) : '';
    if (SCRIPT_EXT.test(w) || INTERPRETERS.has(prev) || w.startsWith('./')) candidates.push(w);
  });
  const realRoots: string[] = [];
  for (const r of roots) {
    // quiet: a root that does not exist holds no scripts.
    const real = await realpath(r).catch(() => null);
    if (real) realRoots.push(real);
  }
  const out: JudgedScript[] & { notShown?: number } = [];
  const seen = new Set<string>();
  let notShown = 0;
  for (const name of candidates) {
    if (name.startsWith('-') || name.includes('\0')) continue;
    const named = isAbsolute(name) ? name : resolve(cwd, name);
    // quiet: a word that is not a path to an existing file is just a word.
    const real = await realpath(named).catch(() => null);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    // A file it runs that the judge will not see is still worth saying exists.
    if (out.length >= MAX_SCRIPTS || !realRoots.some((r) => within(real, r))) {
      notShown++;
      continue;
    }
    const read = await readOne(real);
    if (!read) continue;
    out.push({ name, named, path: real, ...read });
  }
  if (notShown) out.notShown = notShown;
  return out;
}

/** Whether every file still holds what the judge saw. */
export async function scriptsUnchanged(scripts: readonly JudgedScript[]): Promise<boolean> {
  for (const s of scripts) {
    // The name the command will open must still lead to the file that was
    // read — a link swapped in between would run something else.
    // quiet: a name that no longer resolves is a change.
    if ((await realpath(s.named).catch(() => null)) !== s.path) return false;
    const now = await readOne(s.path);
    if (!now || now.hash !== s.hash) return false;
  }
  return true;
}
