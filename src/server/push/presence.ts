import { log } from '../log';

// Who was recently AT a machine — the one input that decides whether a phone is
// worth waking.
//
// The signal is deliberately not "a desktop has an SSE stream open". A laptop
// left open on a desk nobody is sitting at holds that stream for days, and taking
// it as presence would silence the phone precisely in the case the phone exists
// for. What is reported here is real input (the desktop reads the OS idle timer
// and reports while it is under a few minutes — see the heartbeat in
// startup/devices, wired in step 2), so a machine that is merely powered on says
// nothing.
//
// In memory, never devices.json. Presence is a fact about the last few minutes;
// persisting it would mean a server that restarts believes somebody is at a desk
// they left before the reboot, and it would write the registry file every minute
// for a value nothing outside this process reads.
//
// Fail-open by construction: an empty map means "nobody is known to be present",
// which sends the push. The failure mode of a missing heartbeat is a redundant
// notification, not a missed one.

/** Device id → when it last reported a person actually using it (epoch ms). */
const lastActive = new Map<string, number>();

/**
 * How recently a desktop must have been used for a push to be pointless. Five
 * minutes is the same window the desktop applies to the OS idle timer before it
 * stops reporting at all, so the two ends agree on what "at the machine" means
 * without either having to know the other's number is the same.
 */
export const PRESENCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * This device's user did something just now. Called from the desktop's heartbeat
 * channel; a client that never reports simply never suppresses anything.
 */
export function reportPresence(deviceId: string): void {
  lastActive.set(deviceId, Date.now());
}

/**
 * Was anybody at a machine within `windowMs`?
 *
 * Any reporting device counts, because only a client with a screen and an idle
 * timer reports at all — there is no role to filter on (see transport/auth.ts,
 * where 'device' is the only one left) and inventing one here would be a second
 * answer to a question the heartbeat already answers by existing.
 */
export function isAnyDesktopPresent(windowMs: number = PRESENCE_WINDOW_MS): boolean {
  const cutoff = Date.now() - windowMs;
  for (const at of lastActive.values()) {
    if (at >= cutoff) return true;
  }
  // Nothing is pruned on the read path: the map holds one small number per paired
  // device, and an entry that has aged out is already answering "no".
  return false;
}

/** When `deviceId` was last active, or null — diagnostics and tests. */
export function lastActiveAt(deviceId: string): number | null {
  return lastActive.get(deviceId) ?? null;
}

/** Forget every report (a revoked device; tests; a fresh server). */
export function forgetPresence(deviceId?: string): void {
  if (deviceId === undefined) {
    lastActive.clear();
    return;
  }
  if (lastActive.delete(deviceId)) log('push', 'dropped presence for a device', { deviceId });
}
