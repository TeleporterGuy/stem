import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { browseServerFolders } from '../../src/server/workspace/browse';

// The listing behind the remote "add connected folder" picker: directories only,
// dotted names filtered, symlinks-to-directories kept, and unreadable paths
// answered with `error` instead of a throw so the dialog keeps its footing.

const root = mkdtempSync(join(tmpdir(), 'stem-browse-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('browseServerFolders', () => {
  it('lists sub-directories only, sorted, with dot-dirs filtered', async () => {
    const base = join(root, 'tree');
    mkdirSync(join(base, 'beta'), { recursive: true });
    mkdirSync(join(base, 'Alpha'));
    mkdirSync(join(base, '.hidden'));
    writeFileSync(join(base, 'notes.md'), 'not a directory');

    const listing = await browseServerFolders(base);
    // mkdtemp roots can sit behind a symlink (macOS /tmp); resolve() in the
    // handler does not follow links, so compare against the path as given.
    expect(listing.path).toBe(base);
    expect(listing.parent).toBe(dirname(base));
    expect(listing.error).toBeUndefined();
    expect(listing.dirs.map((d) => d.name)).toEqual(['Alpha', 'beta']);
    expect(listing.dirs.map((d) => d.path)).toEqual([join(base, 'Alpha'), join(base, 'beta')]);
  });

  it('keeps a symlink that points at a directory and drops one that dangles', async () => {
    const base = join(root, 'links');
    mkdirSync(join(base, 'real'), { recursive: true });
    symlinkSync(join(base, 'real'), join(base, 'vault'));
    symlinkSync(join(base, 'gone'), join(base, 'dangling'));

    const listing = await browseServerFolders(base);
    expect(listing.dirs.map((d) => d.name)).toEqual(['real', 'vault']);
  });

  it('starts at home when no path is given', async () => {
    const listing = await browseServerFolders();
    expect(listing.path).toBe(homedir());
    expect(listing.home).toBe(homedir());
  });

  it('answers a missing path with an error and an empty list', async () => {
    const listing = await browseServerFolders(join(root, 'no-such-dir'));
    expect(listing.error).toMatch(/No folder at this path/);
    expect(listing.dirs).toEqual([]);
    // Navigation stays alive: the parent is still there to climb back to.
    expect(listing.parent).toBe(root);
  });

  it('answers a file path with the not-a-folder error', async () => {
    const file = join(root, 'plain.txt');
    writeFileSync(file, 'x');
    const listing = await browseServerFolders(file);
    expect(listing.error).toMatch(/file, not a folder/);
    expect(listing.dirs).toEqual([]);
  });

  it('reports the filesystem root as parentless', async () => {
    const listing = await browseServerFolders('/');
    expect(listing.parent).toBeNull();
  });
});
