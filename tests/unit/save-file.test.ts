// save_file: a picture or a file Stem holds, copied to Files, scratch, or a
// writable connected folder — on its own computer when it lives on one.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { saveFiles, type SaveDeps } from '../../src/server/files/save-file';
import { clearOutbox, outboxTake } from '../../src/server/files/outbox';
import { filesRoot, threadWorkspaceDir, workspaceRoot } from '../../src/server/workspace/paths';
import type { ConnectedFolder, DeviceSaveRequest } from '../../src/shared/types';

const local = mkdtempSync(join(tmpdir(), 'stem-save-local-'));
const readonly = mkdtempSync(join(tmpdir(), 'stem-save-ro-'));
const mirror = mkdtempSync(join(tmpdir(), 'stem-save-mirror-'));
const winMirror = mkdtempSync(join(tmpdir(), 'stem-save-winmirror-'));
const outside = mkdtempSync(join(tmpdir(), 'stem-save-outside-'));
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

const folders: ConnectedFolder[] = [
  { id: 'l', path: local, label: 'local', mode: 'readwrite', memorize: true },
  { id: 'r', path: readonly, label: 'notes', mode: 'read', memorize: true },
  {
    id: 'm',
    path: mirror,
    label: 'smallgod',
    mode: 'readwrite',
    memorize: false,
    origin: { deviceId: 'mac-1', clientPath: '/Users/v/smallgod' }
  },
  {
    id: 'w',
    path: winMirror,
    label: 'site',
    mode: 'readwrite',
    memorize: false,
    origin: { deviceId: 'pc-1', clientPath: 'C:\\Users\\v\\site\\' }
  }
];

let sent: Array<{ deviceId: string; request: Omit<DeviceSaveRequest, 'requestId'> }> = [];

function deps(over: Partial<NonNullable<SaveDeps['devices']>> = {}): SaveDeps {
  return {
    findThreadImage: async (_t, id) => (id === 'img_0123456789' ? { mimeType: 'image/png', data: PNG.toString('base64') } : null),
    readRoots: () => [workspaceRoot(), threadWorkspaceDir('').replace(/\/$/, ''), local, readonly, mirror],
    folders: async () => folders,
    devices: {
      hostFor: async () => ({ deviceId: 'mac-1', announcedAt: '', enabled: true, platform: 'darwin', saves: true }),
      isAvailable: () => true,
      label: async () => 'Mac',
      save: async (deviceId, request) => {
        sent.push({ deviceId, request });
        return { ok: true, text: 'Saved' };
      },
      ...over
    }
  };
}

beforeAll(() => {
  // `files/…` as a source resolves the way the model's read tool does (its cwd).
  mkdirSync(join(workspaceRoot(), 'files'), { recursive: true });
  writeFileSync(join(workspaceRoot(), 'files', 'note.txt'), 'hello');
  symlinkSync(outside, join(local, 'escape'));
  mkdirSync(join(local, '.git', 'hooks'), { recursive: true });
  symlinkSync(join(local, '.git', 'hooks'), join(local, 'hooks'));
});

afterEach(() => {
  sent = [];
  clearOutbox();
});

describe('saveFiles', () => {
  it('writes a generated image by id into Files, scratch and a writable local folder', async () => {
    const res = await saveFiles(
      'thread-s',
      [
        { from: 'img_0123456789', to: 'files/art/sheet.png' },
        { from: 'img_0123456789', to: 'work/' },
        { from: 'files/note.txt', to: join(local, 'sub', 'note.txt') }
      ],
      deps()
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(join(filesRoot(), 'art', 'sheet.png'))).toEqual(PNG);
    expect(readFileSync(join(threadWorkspaceDir('thread-s'), 'work', 'img_0123456789.png'))).toEqual(PNG);
    expect(readFileSync(join(local, 'sub', 'note.txt'), 'utf8')).toBe('hello');
  });

  it('replaces an existing file', async () => {
    writeFileSync(join(local, 'old.png'), 'old');
    expect((await saveFiles('thread-s', [{ from: 'img_0123456789', to: join(local, 'old.png') }], deps())).ok).toBe(true);
    expect(readFileSync(join(local, 'old.png'))).toEqual(PNG);
  });

  it('refuses read-only folders, unknown places, traversal and symlinks out', async () => {
    for (const to of [
      join(readonly, 'x.png'),
      join(outside, 'x.png'),
      'files/../../x.png',
      '../x.png',
      join(local, 'escape', 'x.png'),
      join(local, 'escape', 'deeper', 'x.png'),
      join(local, '.git', 'hooks', 'pre-commit'),
      join(local, 'hooks', 'pre-commit'),
      '/Users/v/smallgod/.github/workflows/x.yml'
    ]) {
      const res = await saveFiles('thread-s', [{ from: 'img_0123456789', to }], deps());
      expect(res.ok, to).toBe(false);
    }
    expect(existsSync(join(readonly, 'x.png'))).toBe(false);
    expect(existsSync(join(outside, 'x.png'))).toBe(false);
    expect(existsSync(join(outside, 'deeper'))).toBe(false);
    expect(existsSync(join(local, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('refuses an image this conversation does not hold', async () => {
    const res = await saveFiles('thread-s', [{ from: 'img_ffffffffff', to: 'files/x.png' }], deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('No image');
  });

  it('sends a file for a folder on another computer to that computer, by either path', async () => {
    const res = await saveFiles(
      'thread-s',
      [
        { from: 'img_0123456789', to: '/Users/v/smallgod/public/art/a.png' },
        { from: 'img_0123456789', to: join(mirror, 'public', 'art', 'b.png') }
      ],
      deps()
    );
    expect(res.ok).toBe(true);
    expect(sent.map((s) => [s.deviceId, s.request.path])).toEqual([
      ['mac-1', '/Users/v/smallgod/public/art/a.png'],
      ['mac-1', '/Users/v/smallgod/public/art/b.png']
    ]);
    // The bytes wait in that device's outbox, once.
    const got = await outboxTake('mac-1', sent[0]!.request.outboxId);
    expect(got && readFileSync(got.path)).toEqual(PNG);
    expect(await outboxTake('mac-1', sent[0]!.request.outboxId)).toBeNull();
    expect(await outboxTake('other', sent[1]!.request.outboxId)).toBeNull();
  });

  it('reads a Windows computer\'s folder by its own path rules, whatever this server runs', async () => {
    const res = await saveFiles(
      'thread-s',
      [
        { from: 'img_0123456789', to: 'C:\\Users\\v\\site\\img\\a.png' },
        { from: 'img_0123456789', to: 'c:/users/v/SITE/b.png' }
      ],
      deps()
    );
    expect(res.ok).toBe(true);
    expect(sent.map((s) => [s.deviceId, s.request.path])).toEqual([
      ['pc-1', 'C:\\Users\\v\\site/img/a.png'],
      ['pc-1', 'C:\\Users\\v\\site/b.png']
    ]);
    for (const to of ['C:\\Users\\v\\site\\..\\other\\x.png', 'C:\\Users\\v\\site2\\x.png', 'C:\\Users\\v\\site\\.git\\x', '/Users/v/smallgod/a\\..\\..\\x.png']) {
      const bad = await saveFiles('thread-s', [{ from: 'img_0123456789', to }], deps());
      expect(bad.ok, to).toBe(false);
    }
    expect(sent).toHaveLength(2);
  });

  it('says why a computer cannot take it: switched off, too old, asleep', async () => {
    const to = '/Users/v/smallgod/a.png';
    const off = await saveFiles('t', [{ from: 'img_0123456789', to }], deps({
      hostFor: async () => ({ deviceId: 'mac-1', announcedAt: '', enabled: false, platform: 'darwin' })
    }));
    expect(!off.ok && off.error).toContain('does not accept commands');
    const old = await saveFiles('t', [{ from: 'img_0123456789', to }], deps({
      hostFor: async () => ({ deviceId: 'mac-1', announcedAt: '', enabled: true, platform: 'darwin' })
    }));
    expect(!old.ok && old.error).toContain('too old');
    const asleep = await saveFiles('t', [{ from: 'img_0123456789', to }], deps({ isAvailable: () => false }));
    expect(!asleep.ok && asleep.error).toContain('not connected');
    expect(sent).toHaveLength(0);
  });
});
