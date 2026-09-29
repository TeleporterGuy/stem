import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-downloads' } }));

const { saveImageToDownloads } = await import('../../src/desktop/save-image');

const PNG = `data:image/png;base64,${Buffer.from('fake png bytes').toString('base64')}`;

describe('saveImageToDownloads', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stem-dl-'));
    process.env.STEM_DOWNLOADS_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.STEM_DOWNLOADS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the picture straight into Downloads, named from its prompt', async () => {
    const path = await saveImageToDownloads(PNG, 'A fox, in the snow at dusk — watercolor!');
    expect(path).toBe(join(dir, 'A fox in the snow at.png'));
    expect(await readFile(path, 'utf8')).toBe('fake png bytes');
  });

  it('never overwrites: a second save gets a numbered name', async () => {
    await saveImageToDownloads(PNG, 'fox');
    await saveImageToDownloads(PNG, 'fox');
    expect((await readdir(dir)).sort()).toEqual(['fox 2.png', 'fox.png']);
  });

  it('refuses anything that is not an image data URL', async () => {
    await expect(saveImageToDownloads('data:text/html;base64,PGI+', 'x')).rejects.toThrow('Not an image.');
    await expect(saveImageToDownloads('https://example.com/a.png', 'x')).rejects.toThrow('Not an image.');
  });
});
