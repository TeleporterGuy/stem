import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '../../src/shared/types';
import { updateOffer } from '../../src/shared/updates';

function status(patch: Partial<UpdateStatus>): UpdateStatus {
  return {
    appVersion: '0.5.1',
    mode: 'auto',
    state: 'idle',
    available: null,
    downloadUrl: null,
    checkedAt: null,
    error: null,
    ...patch
  };
}

describe('updateOffer', () => {
  it('offers nothing while current, unchecked, checking or downloading', () => {
    expect(updateOffer(status({}))).toBeNull();
    expect(updateOffer(status({ state: 'checking' }))).toBeNull();
    expect(updateOffer(status({ state: 'downloading', available: '0.5.5' }))).toBeNull();
    expect(updateOffer(status({ mode: 'manual', state: 'idle', checkedAt: 1 }))).toBeNull();
  });

  it('offers a restart once the AppImage has the build downloaded', () => {
    expect(updateOffer(status({ state: 'ready', available: '0.5.5' }))).toBe('restart');
  });

  it('offers the release page to the builds that cannot fetch it themselves', () => {
    expect(updateOffer(status({ mode: 'manual', available: '0.5.5' }))).toBe('page');
  });

  it('offers the release page when the AppImage download or swap failed', () => {
    // The regression: this used to surface only as a row in Settings → App.
    expect(updateOffer(status({ state: 'error', available: '0.5.5', error: 'EACCES' }))).toBe('page');
  });

  it('stays quiet on a failed check that never learned of a newer build', () => {
    expect(updateOffer(status({ state: 'error', error: 'offline' }))).toBeNull();
    expect(updateOffer(status({ mode: 'manual', state: 'error', error: 'offline' }))).toBeNull();
  });

  it('never offers anything under mode none', () => {
    expect(updateOffer(status({ mode: 'none', available: '0.5.5' }))).toBeNull();
  });
});
