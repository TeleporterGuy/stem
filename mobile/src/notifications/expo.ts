// The one place expo-notifications' permission and token calls are made.
//
// Everything that decides anything is in ./register.ts and takes this as an
// injected PushPlatform, for the reason the offline cache splits the same way:
// the decisions deserve a test, and a native module cannot load in one.

import {
  getDevicePushTokenAsync,
  getPermissionsAsync,
  IosAuthorizationStatus,
  requestPermissionsAsync,
  type NotificationPermissionsStatus
} from 'expo-notifications';
import type { PermissionState, PushPlatform } from './register';

/**
 * iOS's answer has more shades than three, and the ones worth collapsing are:
 * PROVISIONAL — granted quietly, notifications arrive in the summary rather than
 * on the lock screen — counts as granted, because a provisional grant does
 * deliver, and asking again would replace something the user has with a dialog
 * they can refuse.
 */
function toPermissionState(status: NotificationPermissionsStatus): PermissionState {
  if (status.granted) return 'granted';
  if (
    status.ios?.status === IosAuthorizationStatus.PROVISIONAL ||
    status.ios?.status === IosAuthorizationStatus.EPHEMERAL
  ) {
    return 'granted';
  }
  return status.status === 'undetermined' ? 'undetermined' : 'denied';
}

export const expoPushPlatform: PushPlatform = {
  async getPermission() {
    return toPermissionState(await getPermissionsAsync());
  },

  async requestPermission() {
    // Alerts, sound and a badge — the three a wake-up needs. Nothing provisional
    // requested: an approval blocks an agent, so it is worth a real notification
    // or it is worth none.
    return toPermissionState(
      await requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } })
    );
  },

  async getDeviceToken() {
    // Throws in Expo Go and on a simulator without a paired Mac's push support.
    // ./register.ts treats the throw as "no push here", which is exactly what it
    // means — see the EXPO GO note there.
    const token = await getDevicePushTokenAsync();
    // Lowercased to match what the server stores; its shape check is
    // case-insensitive but its comparisons are not (src/server/ipc/devices.ts).
    return typeof token.data === 'string' && token.data ? token.data.toLowerCase() : null;
  }
};
