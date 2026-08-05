import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

/** Learned prefixes — one per line. Comments (#) and blanks ignored. */
export function allowlistPath(): string {
  return join(homedir(), '.pi', 'agent', '.security-gate-allowlist');
}

export function loadAllowlist(path: string = allowlistPath()): string[] {
  try {
    const raw = readFileSync(path, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

export function saveAllowlist(prefixes: string[], path: string = allowlistPath()): void {
  mkdirSync(join(homedir(), '.pi', 'agent'), { recursive: true });
  const existing = loadAllowlist(path);
  const merged = [...existing];
  for (const p of prefixes) {
    if (p && !merged.includes(p)) merged.push(p);
  }
  const body = [
    '# security-gate learned allowlist — one command prefix per line',
    '# Prefer narrow prefixes (git status) over wide ones (git).',
    ...merged,
    ''
  ].join('\n');
  writeFileSync(path, body, 'utf8');
}
