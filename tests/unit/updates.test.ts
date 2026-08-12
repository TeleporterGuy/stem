// The update check's two decisions a unit can hold still: what a GitHub
// `/releases/latest` redirect does and doesn't name, and that a dev run (the
// stub's `isPackaged: false`) is mode `none` — a timer that never starts and a
// check that answers without reaching for the network.

import { describe, expect, it } from 'vitest';
import { createUpdates, parseLatestRelease } from '../../src/desktop/updates';

describe('parseLatestRelease', () => {
  it('reads the tag out of the redirect, with or without the v', () => {
    expect(parseLatestRelease('https://github.com/join3r/stem/releases/tag/v0.4.0')).toEqual({
      version: '0.4.0',
      url: 'https://github.com/join3r/stem/releases/tag/v0.4.0'
    });
    expect(parseLatestRelease('https://github.com/join3r/stem/releases/tag/0.4.0')?.version).toBe('0.4.0');
  });

  it('rebuilds the URL rather than trusting the wire', () => {
    // A redirect through some other host still yields a github.com/join3r/stem
    // address — the tag is the only thing taken from the header.
    expect(parseLatestRelease('https://evil.example.com/releases/tag/v9.9.9')?.url).toBe(
      'https://github.com/join3r/stem/releases/tag/v9.9.9'
    );
  });

  it('refuses anything that does not name a version tag', () => {
    // A repo with no releases redirects nowhere useful; an error page has no tag.
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease('')).toBeNull();
    expect(parseLatestRelease('https://github.com/join3r/stem/releases')).toBeNull();
    expect(parseLatestRelease('https://github.com/join3r/stem/releases/tag/nightly')).toBeNull();
    expect(parseLatestRelease('https://github.com/join3r/stem/releases/tag/v1.0.0/extra')).toBeNull();
  });
});

describe('a dev run', () => {
  it('is mode none: nothing to update, and a check says so without looking', async () => {
    const pushed: unknown[] = [];
    const updates = createUpdates({ send: (s) => pushed.push(s), openExternal: () => undefined });

    expect(updates.status().mode).toBe('none');
    expect((await updates.check()).state).toBe('idle');
    await updates.install(); // a no-op, not a throw
    expect(pushed).toEqual([]); // nothing moved, so nothing was announced
    updates.close();
  });
});
