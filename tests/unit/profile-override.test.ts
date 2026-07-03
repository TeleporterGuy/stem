// resolveProfileOverride — the alternate-profile resolver behind `--fresh` /
// `--profile=<name>` (and their STEM_FRESH / STEM_PROFILE env equivalents). Args are
// injected so this runs without Electron and with a fixed clock.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveProfileOverride } from '../../src/main/workspace/paths';

const APPDATA = '/appdata';
const CONTAINER = join(APPDATA, 'Stem Profiles');
const CLOCK = () => new Date('2026-07-03T09:08:07.006Z');
const NO_ENV: NodeJS.ProcessEnv = {};

describe('resolveProfileOverride', () => {
  it('returns null when nothing is requested', () => {
    expect(resolveProfileOverride(['node', 'app'], NO_ENV, APPDATA, CLOCK)).toBeNull();
  });

  it('--fresh makes a timestamped dir under the container', () => {
    const r = resolveProfileOverride(['node', 'app', '--fresh'], NO_ENV, APPDATA, CLOCK);
    expect(r).toEqual({
      label: 'fresh-2026-07-03T09-08-07-006Z',
      userDataDir: join(CONTAINER, 'fresh-2026-07-03T09-08-07-006Z')
    });
  });

  it('STEM_FRESH=1 behaves like --fresh', () => {
    const r = resolveProfileOverride(['node', 'app'], { STEM_FRESH: '1' }, APPDATA, CLOCK);
    expect(r?.label).toBe('fresh-2026-07-03T09-08-07-006Z');
  });

  it('--profile=<name> maps to a named dir under the container', () => {
    const r = resolveProfileOverride(['node', 'app', '--profile=demo'], NO_ENV, APPDATA, CLOCK);
    expect(r).toEqual({ label: 'demo', userDataDir: join(CONTAINER, 'demo') });
  });

  it('STEM_PROFILE=<name> behaves like --profile', () => {
    const r = resolveProfileOverride(['node', 'app'], { STEM_PROFILE: 'demo' }, APPDATA, CLOCK);
    expect(r).toEqual({ label: 'demo', userDataDir: join(CONTAINER, 'demo') });
  });

  it('sanitizes names so they cannot escape the container', () => {
    // Separators become dashes; the result is a literal basename, so join() cannot
    // traverse out of the container even though the input contained "../".
    const r = resolveProfileOverride(['node', 'app', '--profile=../evil/x'], NO_ENV, APPDATA, CLOCK);
    expect(r?.label).toBe('..-evil-x');
    expect(r?.userDataDir).toBe(join(CONTAINER, '..-evil-x'));
    expect(r?.userDataDir.startsWith(CONTAINER)).toBe(true);
  });

  it('fresh wins over a named profile (precedence)', () => {
    const r = resolveProfileOverride(
      ['node', 'app', '--fresh', '--profile=demo'],
      { STEM_PROFILE: 'demo' },
      APPDATA,
      CLOCK
    );
    expect(r?.label.startsWith('fresh-')).toBe(true);
  });

  it('ignores a blank/whitespace profile name', () => {
    expect(resolveProfileOverride(['node', 'app'], { STEM_PROFILE: '   ' }, APPDATA, CLOCK)).toBeNull();
  });

  it('CLI flag takes precedence over the env profile name', () => {
    const r = resolveProfileOverride(
      ['node', 'app', '--profile=flagwins'],
      { STEM_PROFILE: 'envloses' },
      APPDATA,
      CLOCK
    );
    expect(r?.label).toBe('flagwins');
  });
});
