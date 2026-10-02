import type { UpdateStatus } from './types';

/**
 * What a newer Stem can be offered as, from where the updater stands — the one
 * answer the dialog, the banner under the title bar and Settings → App all
 * agree on:
 *
 *   restart — the AppImage has the build downloaded; a restart finishes it.
 *   page    — the build sits on the release page: every mac and deb install,
 *             and an AppImage whose download or swap failed. The failure used
 *             to show only as a row in Settings, which is a build that announces
 *             itself to nobody; it is still a newer Stem, so it is offered the
 *             way a deb's is.
 *   null    — nothing to offer yet (current, unchecked, or still downloading).
 */
export type UpdateOffer = 'restart' | 'page' | null;

export function updateOffer(u: UpdateStatus): UpdateOffer {
  if (!u.available) return null;
  if (u.state === 'ready') return 'restart';
  if (u.mode === 'manual') return 'page';
  if (u.mode === 'auto' && u.state === 'error') return 'page';
  return null;
}
