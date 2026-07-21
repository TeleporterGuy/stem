import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { protectedRootsPath } from '../workspace/paths';

// Main-side twin of the bridge extension's protected-roots gate (which cannot be
// imported — it lives in the pi child's .mjs). Enforces read-only connected
// folders against run_command with the same fail-closed stance as the MCP path
// guard: we can't tell whether a command would read or write inside a protected
// root, so any reference to one blocks the command. Defense-in-depth, not a
// sandbox — the assistant can still read those folders with its read/grep tools.

/** Absolute-path-looking tokens inside a command string (plain or ~-prefixed). */
const PATHISH_RE = /(?:~|\/)[^\s'"`;|&<>]+/g;

function canonicalish(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

export interface ProtectedScanResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Read the protected roots published by main (protected-roots.json under the pi
 * home). Missing file = no read-only folders (the normal state before the first
 * publish); a present-but-corrupt file throws — the caller must fail closed.
 */
export function readProtectedRoots(path: string = protectedRootsPath()): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw) as { roots?: unknown };
  if (!Array.isArray(parsed.roots)) throw new Error('protected-roots.json has no roots array');
  return parsed.roots.filter((r): r is string => typeof r === 'string' && !!r).map(canonicalish);
}

/**
 * Fail-closed scan of a command + its resolved cwd against the read-only
 * connected-folder roots. Any hit (or unreadable gate state) blocks.
 */
export function scanProtected(
  command: string,
  cwd: string,
  rootsPath: string = protectedRootsPath()
): ProtectedScanResult {
  let roots: string[];
  try {
    roots = readProtectedRoots(rootsPath);
  } catch {
    return {
      blocked: true,
      reason: 'The read-only folder list could not be read, so the command was blocked to be safe.'
    };
  }
  if (!roots.length) return { blocked: false };

  const home = process.env.HOME ?? '';
  const targets = [cwd];
  for (const match of command.match(PATHISH_RE) ?? []) {
    targets.push(match.startsWith('~') ? home + match.slice(1) : match);
  }
  for (const target of targets) {
    const canonical = canonicalish(target);
    const hit = roots.find((root) => isInside(canonical, root));
    if (hit) {
      return {
        blocked: true,
        reason:
          `The command touches "${hit}", a folder connected to Stem read-only. Commands cannot run ` +
          'against read-only folders (Stem cannot tell reads from writes). Use the built-in read/grep/find ' +
          'tools there instead, or ask the user to switch the folder to read & write in the Folders tab.'
      };
    }
  }
  return { blocked: false };
}
