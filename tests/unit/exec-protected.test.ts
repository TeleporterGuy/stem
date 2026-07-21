import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProtected } from '../../src/main/exec/protected';

// The main-side fail-closed guard for read-only connected folders: any command
// or cwd referencing a protected root is blocked; unreadable gate state blocks
// everything.

let dir: string;
let rootsPath: string;
let vault: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stem-exec-protected-')));
  vault = join(dir, 'vault');
  rootsPath = join(dir, 'protected-roots.json');
  writeFileSync(rootsPath, JSON.stringify({ roots: [vault] }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scanProtected', () => {
  it('allows commands that touch nothing protected', () => {
    expect(scanProtected('ls -la', join(dir, 'elsewhere'), rootsPath).blocked).toBe(false);
  });

  it('blocks a cwd inside a protected root', () => {
    const res = scanProtected('ls', join(vault, 'notes'), rootsPath);
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain(vault);
  });

  it('blocks a path token inside a protected root, quoted or not', () => {
    expect(scanProtected(`cat ${vault}/daily.md`, dir, rootsPath).blocked).toBe(true);
    expect(scanProtected(`rm -rf "${vault}/sub"`, dir, rootsPath).blocked).toBe(true);
  });

  it('does not block sibling paths that merely share a prefix', () => {
    expect(scanProtected(`ls ${vault}-backup`, dir, rootsPath).blocked).toBe(false);
  });

  it('treats a missing gate file as no protected roots', () => {
    expect(scanProtected('ls', dir, join(dir, 'missing.json')).blocked).toBe(false);
  });

  it('fails closed on a corrupt gate file', () => {
    writeFileSync(rootsPath, 'not json');
    expect(scanProtected('ls', dir, rootsPath).blocked).toBe(true);
    writeFileSync(rootsPath, JSON.stringify({ roots: 'nope' }));
    expect(scanProtected('ls', dir, rootsPath).blocked).toBe(true);
  });
});
