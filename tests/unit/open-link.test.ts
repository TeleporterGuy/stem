import { describe, expect, it } from 'vitest';
import { classifyLink } from '../../src/desktop/open-link';

describe('classifyLink', () => {
  it('sends web and mail links to the system handler', () => {
    expect(classifyLink('https://example.com/a')).toEqual({ kind: 'external', url: 'https://example.com/a' });
    expect(classifyLink('mailto:a@b.c')).toEqual({ kind: 'external', url: 'mailto:a@b.c' });
  });

  it('opens a file:// document with its default app', () => {
    expect(classifyLink('file:///Users/me/Downloads/pigs%20farms.csv')).toEqual({
      kind: 'open',
      path: '/Users/me/Downloads/pigs farms.csv',
    });
    expect(classifyLink('file:///Users/me/Downloads/')).toEqual({ kind: 'open', path: '/Users/me/Downloads/' });
  });

  it('only reveals files that would run code when opened', () => {
    for (const p of ['/tmp/x.command', '/Applications/Evil.app/', '/tmp/x.SH', '/tmp/x.webloc', '/tmp/x.scpt']) {
      expect(classifyLink(`file://${p}`)).toEqual({ kind: 'reveal', path: p });
    }
  });

  it('ignores other schemes and garbage', () => {
    for (const u of ['javascript:alert(1)', 'tel:123', 'vscode://x', 'not a url', 'file://remote-host/share/x.csv']) {
      expect(classifyLink(u)).toEqual({ kind: 'ignore' });
    }
  });
});
