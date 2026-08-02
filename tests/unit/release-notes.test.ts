// The "what's new" popup's decision logic: how RELEASE_NOTES.md is split into
// version sections, and which of those a given install is owed. Everything here
// is pure — the IPC layer supplies the running version and the saved marker.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareVersions, parseReleaseNotes, selectUnseen } from '../../src/main/workspace/release-notes';

const SAMPLE = `# Stem release notes

Intro prose that belongs to no version.

## 0.3.0 — Unreleased

### Added

- A thing.

## 0.2.0 — 2026-07-29

Shipped stuff.

## 0.1.0 — 2026-07-20

The first release.
`;

describe('parseReleaseNotes', () => {
  it('splits on version headings and drops the preamble', () => {
    const entries = parseReleaseNotes(SAMPLE);
    expect(entries.map((e) => e.version)).toEqual(['0.3.0', '0.2.0', '0.1.0']);
    expect(entries.map((e) => e.label)).toEqual(['Unreleased', '2026-07-29', '2026-07-20']);
    expect(entries[2].body).toBe('The first release.');
    expect(entries[0].body).toContain('- A thing.');
    expect(entries[0].body).not.toContain('Shipped stuff');
  });

  it('ignores headings that are not versions', () => {
    expect(parseReleaseNotes('## Upgrading\n\nblah\n')).toEqual([]);
  });

  it('accepts a v-prefix, a plain heading, and either dash', () => {
    const entries = parseReleaseNotes('## v1.2 - a\ntext\n\n## 2.0\nmore\n');
    expect(entries.map((e) => [e.version, e.label])).toEqual([
      ['1.2', 'a'],
      ['2.0', '']
    ]);
  });

  it('does not split on a ## inside a fenced code block', () => {
    const entries = parseReleaseNotes('## 1.0 — x\n\n```md\n## 2.0 — not a section\n```\n\ntail\n');
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain('## 2.0 — not a section');
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBe(-1);
  });
});

describe('selectUnseen', () => {
  const entries = parseReleaseNotes(SAMPLE);

  it('shows only the running version when nothing has been recorded', () => {
    // The already-onboarded install upgrading INTO this feature: one section, not
    // the whole backlog.
    expect(selectUnseen(entries, null, '0.2.0').map((e) => e.version)).toEqual(['0.2.0']);
  });

  it('shows every release the user skipped', () => {
    expect(selectUnseen(entries, '0.1.0', '0.3.0').map((e) => e.version)).toEqual(['0.3.0', '0.2.0']);
  });

  it('hides notes written ahead of the running build', () => {
    // 0.3.0 is in the file but package.json still says 0.2.0 — the user must not
    // be told about features their build does not have.
    expect(selectUnseen(entries, '0.1.0', '0.2.0').map((e) => e.version)).toEqual(['0.2.0']);
  });

  it('shows nothing once the current version has been seen', () => {
    expect(selectUnseen(entries, '0.2.0', '0.2.0')).toEqual([]);
  });

  it('shows nothing when the marker is ahead of the build (a downgrade)', () => {
    expect(selectUnseen(entries, '0.3.0', '0.2.0')).toEqual([]);
  });
});

describe('the shipped RELEASE_NOTES.md', () => {
  // A malformed heading would silently cost users a popup, and the file is edited
  // by hand every release — so parse the real thing.
  const entries = parseReleaseNotes(readFileSync('RELEASE_NOTES.md', 'utf8'));

  it('parses into version sections, newest first', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (let i = 1; i < entries.length; i++) {
      expect(compareVersions(entries[i - 1].version, entries[i].version)).toBe(1);
    }
  });

  it('has a section for the version package.json ships', () => {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(entries.map((e) => e.version)).toContain(version);
  });

  it('gives every section a non-empty body', () => {
    for (const entry of entries) expect(entry.body.length).toBeGreaterThan(0);
  });
});
