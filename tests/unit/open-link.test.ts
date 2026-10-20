import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyLink } from '../../src/desktop/open-link';

// The paths below are POSIX; on Windows the same ones live on C:.
const native = (p: string) => (process.platform === 'win32' ? `C:${p.replaceAll('/', '\\')}` : p);
const fileUrl = (p: string) => pathToFileURL(native(p)).href;

describe('classifyLink', () => {
  it('sends web, mail and phone links to the system handler', () => {
    expect(classifyLink('https://example.com/a')).toEqual({ kind: 'external', url: 'https://example.com/a' });
    expect(classifyLink('mailto:a@b.c')).toEqual({ kind: 'external', url: 'mailto:a@b.c' });
    expect(classifyLink('tel:+421905123456')).toEqual({ kind: 'external', url: 'tel:+421905123456' });
  });

  it('opens a file:// document with its default app', () => {
    expect(classifyLink(fileUrl('/Users/me/Downloads/pigs farms.csv'))).toEqual({
      kind: 'open',
      path: native('/Users/me/Downloads/pigs farms.csv'),
    });
    expect(classifyLink(fileUrl('/tmp/Report.PDF'))).toEqual({ kind: 'open', path: native('/tmp/Report.PDF') });
  });

  it('only reveals anything that is not a known document type', () => {
    for (const p of [
      '/tmp/x.command', '/Applications/Evil.app/', '/Applications/Evil.app', '/tmp/x.SH', '/tmp/x.webloc',
      '/tmp/x.scpt', '/tmp/payload', '/tmp/x.mobileconfig', '/tmp/x.xlsm', '/tmp/x.prefPane', '/Users/me/Downloads/',
      '/tmp/x.csv/', '/tmp/x.csv.command',
    ]) {
      expect(classifyLink(fileUrl(p))).toEqual({ kind: 'reveal', path: native(p) });
    }
  });

  it('ignores other schemes and garbage', () => {
    for (const u of ['javascript:alert(1)', 'vscode://x', 'not a url', 'file://remote-host/share/x.csv', 'file://192.168.1.5/c$/x.pdf']) {
      expect(classifyLink(u)).toEqual({ kind: 'ignore' });
    }
  });
});
