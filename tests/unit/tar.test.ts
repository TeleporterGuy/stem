// The tar reader and writer Stem carries instead of a dependency.
//
// Two properties matter, and they are not the same property. The archive has to
// be a real tarball — one that `tar xf` on a server years from now unpacks
// correctly, including the long paths a session tree produces — and unpacking one
// has to be safe, because a tarball is the classic way to write a file somewhere
// nobody asked for. The traversal cases below are the whole reason this file
// exists rather than a call to `child_process.spawn('tar')`.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTar, listTar, readTarMember, writeTar, type TarInput } from '../../src/server/workspace/tar';

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stem-tar-test-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileEntry(path: string, source: string, mode = 0o644): TarInput {
  return { path, type: 'file', mode, mtime: 1_700_000_000, size: statSync(source).size, source: { file: source } };
}

describe('writing and reading a tar archive', () => {
  it('round-trips files, folders and their modes', async () => {
    const src = scratch();
    const dest = scratch();
    mkdirSync(join(src, 'sub'), { recursive: true });
    mkdirSync(join(src, 'empty'), { recursive: true });
    writeFileSync(join(src, 'plain.txt'), 'hello');
    writeFileSync(join(src, 'sub', 'secret.key'), 'shh', { mode: 0o600 });

    const archive = join(scratch(), 'out.tar');
    await writeTar(archive, [
      { path: 'empty', type: 'directory', mode: 0o700, mtime: 1_700_000_000, size: 0 },
      fileEntry('plain.txt', join(src, 'plain.txt')),
      fileEntry('sub/secret.key', join(src, 'sub', 'secret.key'), 0o600)
    ]);

    const landed = await extractTar(archive, dest);
    expect(readFileSync(join(dest, 'plain.txt'), 'utf8')).toBe('hello');
    expect(readFileSync(join(dest, 'sub', 'secret.key'), 'utf8')).toBe('shh');
    // The 0600 files must land 0600 — that is half the point of restoring modes.
    expect(statSync(join(dest, 'sub', 'secret.key')).mode & 0o777).toBe(0o600);
    // An empty folder survives, which it would not if directories were implied
    // by the files under them.
    expect(statSync(join(dest, 'empty')).isDirectory()).toBe(true);
    // Directory members carry the trailing slash tar has always written them with.
    expect(landed.map((m) => m.path)).toEqual(['empty/', 'plain.txt', 'sub/secret.key']);
  });

  it('carries a path too long for a ustar header, via a PAX record', async () => {
    const src = scratch();
    // A real session path shape: nested uuids under pi-home/sessions.
    const deep = ['pi-home', 'sessions', 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)].join('/');
    writeFileSync(join(src, 'payload'), 'deep');
    const archive = join(scratch(), 'long.tar');
    await writeTar(archive, [fileEntry(`${deep}/turn.jsonl`, join(src, 'payload'))]);

    const dest = scratch();
    await extractTar(archive, dest);
    expect(readFileSync(join(dest, ...deep.split('/'), 'turn.jsonl'), 'utf8')).toBe('deep');
    expect((await listTar(archive)).map((m) => m.path)).toEqual([`${deep}/turn.jsonl`]);
  });

  it('is a tarball the system tar agrees with', async () => {
    // The archive is a backup, so being readable by something that is not this
    // code is the property that matters most and the one a unit test can least
    // fake. Skipped where there is no tar (Windows CI).
    const src = scratch();
    mkdirSync(join(src, 'pi-home'), { recursive: true });
    writeFileSync(join(src, 'pi-home', 'mcp.json'), '{"servers":{}}');
    const archive = join(scratch(), 'system.tar');
    await writeTar(archive, [
      fileEntry('pi-home/mcp.json', join(src, 'pi-home', 'mcp.json')),
      { path: `${'x'.repeat(120)}/name.txt`, type: 'file', mode: 0o644, mtime: 1_700_000_000, size: 3, source: { data: Buffer.from('abc') } }
    ]);

    let listing: string;
    try {
      listing = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' });
    } catch {
      return; // no tar on this machine; the round trip above still covers the format
    }
    expect(listing).toContain('pi-home/mcp.json');
    expect(listing).toContain('name.txt');
  });

  it('hands back one member without unpacking the rest', async () => {
    const src = scratch();
    writeFileSync(join(src, 'big'), 'x'.repeat(200_000));
    const archive = join(scratch(), 'one.tar');
    await writeTar(archive, [
      { path: 'stem-export.json', type: 'file', mode: 0o600, mtime: 1, size: 9, source: { data: Buffer.from('{"a":1}\n\n') } },
      fileEntry('big', join(src, 'big'))
    ]);
    expect((await readTarMember(archive, 'stem-export.json'))?.toString('utf8')).toBe('{"a":1}\n\n');
    expect(await readTarMember(archive, 'nope')).toBeNull();
  });
});

describe('unpacking an archive that is trying something', () => {
  /** Build an archive with a member name of our choosing — writeTar asks no questions. */
  async function archiveNamed(path: string): Promise<string> {
    const archive = join(scratch(), 'evil.tar');
    await writeTar(archive, [
      { path, type: 'file', mode: 0o644, mtime: 1, size: 5, source: { data: Buffer.from('pwned') } }
    ]);
    return archive;
  }

  it('refuses a member that climbs out of the destination', async () => {
    const archive = await archiveNamed('../escaped.txt');
    await expect(extractTar(archive, scratch())).rejects.toThrow(/climbs out/);
  });

  it('refuses a member buried under a legitimate-looking prefix', async () => {
    const archive = await archiveNamed('pi-home/sessions/../../../../escaped.txt');
    await expect(extractTar(archive, scratch())).rejects.toThrow(/climbs out/);
  });

  it('refuses an absolute member', async () => {
    const archive = await archiveNamed('/etc/cron.d/pwn');
    await expect(extractTar(archive, scratch())).rejects.toThrow(/absolute path/);
  });

  it('refuses a Windows drive-letter member', async () => {
    const archive = await archiveNamed('C:/Windows/System32/pwn.dll');
    await expect(extractTar(archive, scratch())).rejects.toThrow(/absolute path/);
  });

  it('refuses a symlink rather than skipping it', async () => {
    // A symlink is how a member written LATER writes outside the destination, so
    // an archive containing one is refused whole. Built by patching the typeflag
    // of a valid header and repairing its checksum — writeTar cannot emit one.
    const archive = join(scratch(), 'link.tar');
    await writeTar(archive, [
      { path: 'escape', type: 'file', mode: 0o644, mtime: 1, size: 0, source: { data: Buffer.alloc(0) } }
    ]);
    const bytes = readFileSync(archive);
    bytes[156] = '2'.charCodeAt(0); // typeflag: symlink
    bytes.write('../../outside', 157, 100, 'ascii'); // linkname
    bytes.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += bytes[i];
    bytes.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    writeFileSync(archive, bytes);

    await expect(extractTar(archive, scratch())).rejects.toThrow(/link/);
  });

  it('refuses a truncated archive instead of unpacking half a file', async () => {
    const src = scratch();
    writeFileSync(join(src, 'payload'), 'y'.repeat(5000));
    const archive = join(scratch(), 'cut.tar');
    await writeTar(archive, [fileEntry('payload', join(src, 'payload'))]);
    const bytes = readFileSync(archive);
    writeFileSync(archive, bytes.subarray(0, 1600));
    await expect(extractTar(archive, scratch())).rejects.toThrow(/ends in the middle/);
  });
});
