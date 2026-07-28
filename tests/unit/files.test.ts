// Files-place suite — ported from scripts/files-verify.mjs. Exercises the REAL
// files store + inject against the throwaway STEM_FILES_DIR from setup-unit.ts:
// listing/grouping by subfolder, add (collisions + subdirs), the context builder,
// the traversal guard, and remove.
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../src/main/files/store';
import * as inject from '../../src/main/files/inject';

const root = process.env.STEM_FILES_DIR!;
const stage = join(root, '..', 'stage');
const srcA = join(stage, 'a.txt');
const srcCake = join(stage, 'cake.pdf');

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(srcA, 'hello');
  writeFileSync(srcCake, 'PASSPHRASE-7731 chocolate');
});

describe('Files place', () => {
  it('starts empty with no context', async () => {
    const listing = await store.listFiles();
    expect(listing.files.length).toBe(0);
    expect(listing.dirs.length).toBe(0);
    expect(await inject.buildFilesContext()).toBeNull();
  });

  it('adds a file at the root', async () => {
    const listing = await store.addFiles([srcA]);
    expect(listing.files.some((f) => f.rel === 'a.txt' && f.dir === '')).toBe(true);
  });

  it('adds into a subfolder created on demand', async () => {
    const listing = await store.addFiles([srcCake], 'Recipes');
    expect(listing.files.some((f) => f.rel === 'Recipes/cake.pdf' && f.dir === 'Recipes')).toBe(true);
    expect(listing.dirs).toContain('Recipes');
  });

  it('renames colliding files to numbered siblings', async () => {
    const listing = await store.addFiles([srcA]);
    expect(listing.files.some((f) => f.rel === 'a-1.txt')).toBe(true);
  });

  it('does not overwrite files added concurrently with the same basename', async () => {
    const sources = Array.from({ length: 20 }, (_, i) => {
      const dir = join(stage, `concurrent-${i}`);
      mkdirSync(dir, { recursive: true });
      const source = join(dir, 'same.txt');
      writeFileSync(source, `source-${i}`);
      return source;
    });

    await Promise.all(sources.map((source) => store.addFiles([source])));
    const matches = (await store.listFiles()).files.filter((file) => /^same(?:-\d+)?\.txt$/.test(file.rel));
    expect(matches).toHaveLength(sources.length);
  });

  it('builds a context that lists names (with files/ prefix) but never contents', async () => {
    const ctx = await inject.buildFilesContext();
    expect(ctx).toBeTruthy();
    expect(ctx!).toContain('files/Recipes/cake.pdf');
    expect(ctx!).not.toContain('PASSPHRASE-7731');
  });

  it('treats an escaping (path-traversal) remove as a no-op', async () => {
    const before = (await store.listFiles()).files.length;
    await store.removeFile('../stage/a.txt');
    expect((await store.listFiles()).files.length).toBe(before);
  });

  it('removes a real file', async () => {
    const listing = await store.removeFile('Recipes/cake.pdf');
    expect(listing.files.some((f) => f.rel === 'Recipes/cake.pdf')).toBe(false);
  });
});

describe('Files subfolders', () => {
  it('creates an empty subfolder that still shows up in the listing', async () => {
    // The Files tab renders sections from `dirs`, so a folder the user just made
    // has to survive a listing round-trip before anything is dropped into it.
    const listing = await store.createSubdir('Invoices');
    expect(listing.dirs).toContain('Invoices');
    expect(listing.files.some((f) => f.dir === 'Invoices')).toBe(false);
  });

  it('trims the name and is idempotent for one that already exists', async () => {
    const listing = await store.createSubdir('  Invoices  ');
    expect(listing.dirs.filter((d) => d === 'Invoices')).toHaveLength(1);
  });

  it('rejects traversal, nesting, and hidden names', async () => {
    for (const bad of ['..', '.', '', '   ', 'a/b', '../escape', '.hidden']) {
      await expect(store.createSubdir(bad)).rejects.toThrow(/Unsafe files subfolder/);
    }
    await expect(store.removeSubdir('../stage')).rejects.toThrow(/Unsafe files subfolder/);
    // The guard must not have deleted anything on its way to throwing.
    expect((await store.listFiles()).dirs).toContain('Invoices');
  });

  it('removes a subfolder along with the files inside it', async () => {
    await store.addFiles([srcA], 'Invoices');
    expect((await store.listFiles()).files.some((f) => f.dir === 'Invoices')).toBe(true);

    const listing = await store.removeSubdir('Invoices');
    expect(listing.dirs).not.toContain('Invoices');
    expect(listing.files.some((f) => f.dir === 'Invoices')).toBe(false);
  });
});
