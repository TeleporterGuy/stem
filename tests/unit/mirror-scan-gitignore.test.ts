// A mirror leaves out what the folder's own .gitignore files leave out, so a
// repo's build output (ios/build, dist) stays on the machine it was built on.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanMirrorRoot } from '../../src/desktop/mirror-host/scan';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'stem-mirror-gitignore-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const rels = async (dir: string) => (await scanMirrorRoot(dir)).entries.map((e) => e.rel).sort();

describe('mirror scan and .gitignore', () => {
  it('skips what the root and nested .gitignore files exclude', async () => {
    const dir = tree({
      '.gitignore': 'dist/\n*.log\n/state/\n',
      'src/app.ts': 'x',
      'dist/app.js': 'x',
      'debug.log': 'x',
      'state/db': 'x',
      'docs/state/notes.md': 'x',
      'ios/.gitignore': 'build/\n',
      'ios/App.swift': 'x',
      'ios/build/Stem.app/Stem': 'x',
      'other/build/kept.txt': 'x'
    });
    expect(await rels(dir)).toEqual([
      '.gitignore',
      'docs/state/notes.md',
      'ios/.gitignore',
      'ios/App.swift',
      'other/build/kept.txt',
      'src/app.ts'
    ]);
  });

  it('lets a deeper !pattern re-include a file', async () => {
    const dir = tree({
      '.gitignore': '*.env\n',
      'a.env': 'x',
      'config/.gitignore': '!public.env\n',
      'config/public.env': 'x',
      'config/secret.env': 'x'
    });
    expect(await rels(dir)).toEqual(['.gitignore', 'config/.gitignore', 'config/public.env']);
  });

  it('mirrors everything in a folder without a .gitignore, as before', async () => {
    const dir = tree({ 'build/out.txt': 'x', 'dist/a.js': 'x' });
    expect(await rels(dir)).toEqual(['build/out.txt', 'dist/a.js']);
  });
});
