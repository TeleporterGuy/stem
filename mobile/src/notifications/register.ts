// Getting this phone woken: ask, get the token iOS gives us, tell the server.
//
// THREE THINGS MUST BE TRUE and they are true at different times, which is the
// whole reason this is a function with a result rather than a call at startup:
//
//   paired      a token is meaningless without a server to send it to, and
//               `devices:registerPush` refuses a caller it cannot name. This is
//               also why the permission prompt comes AFTER pairing rather than on
//               first launch: an app that asks to send notifications before it
//               has anything to notify you about is an app people say no to, and
//               iOS gives you exactly one prompt, forever.
//   permission  the user said yes. `undetermined` is asked once; a `denied` is
//               taken as final — re-prompting is impossible anyway (iOS ignores
//               the second request) and Settings is the only way back.
//   a token     the native APNs device token, which only exists in a build with
//               the entitlement. See EXPO GO below.
//
// EXPO GO. Remote push does not work there: since SDK 53 Expo Go carries no APNs
// entitlement of its own for other people's projects, and asking for a device
// token throws. That is not a failure worth a dialog — everything else in the app
// works in Expo Go, and the run is a development run — so this degrades to
// nothing, logged once, and the app carries on. Detected by the attempt failing
// rather than by sniffing the environment: `Constants.executionEnvironment` says
// `storeClient` for both Expo Go and a dev client (where push DOES work), so the
// only honest test is to ask for the token and see.
//
// Idempotent by design, because the server's handler is: it stores whatever the
// caller sends under the caller's device. So the app registers on every launch
// and on every token rotation without needing to know which of those happened.

/** What happened, in the vocabulary the log and the tests both want. */
export type RegistrationOutcome =
  | 'registered'
  /** No pairing yet — nothing to register with. Try again after pairing. */
  | 'unpaired'
  /** The user declined, now or previously. Nothing to do until Settings changes. */
  | 'denied'
  /** No native token here: Expo Go, a simulator, an entitlement-less build. */
  | 'unsupported'
  /** The server refused or could not be reached. The next launch tries again. */
  | 'failed';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/**
 * Everything about this that touches a native module, behind four functions, so
 * the decision above can be tested without one. ./expo.ts is the real one.
 */
export interface PushPlatform {
  getPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  /**
   * The native APNs device token as lowercase hex, or null where there is no such
   * thing. Throwing is also allowed and means the same — see EXPO GO above.
   */
  getDeviceToken(): Promise<string | null>;
}

export interface RegisterOptions {
  /** Whether this phone holds a credential for a server right now. */
  paired: boolean;
  platform: PushPlatform;
  /** Sends `devices:registerPush`. Rejects like any RPC. */
  register(token: string): Promise<void>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Run the whole sequence once. Never throws: a phone that cannot be woken is a
 * phone that works exactly as it did before this feature existed, and no part of
 * launching the app may hang off it.
 */
export async function registerForPush(options: RegisterOptions): Promise<RegistrationOutcome> {
  const log = options.log ?? ((): void => undefined);
  if (!options.paired) return 'unpaired';

  let permission: PermissionState;
  try {
    permission = await options.platform.getPermission();
    // Only ever asked when nothing has been decided. Calling request() on a
    // `denied` would be a no-op on iOS, and calling it on a `granted` is a
    // pointless round trip through the OS on every launch.
    if (permission === 'undetermined') permission = await options.platform.requestPermission();
  } catch (e) {
    log('could not read notification permission', { error: String((e as Error)?.message ?? e) });
    return 'failed';
  }
  if (permission !== 'granted') return 'denied';

  let token: string | null;
  try {
    token = await options.platform.getDeviceToken();
  } catch (e) {
    log('no push token here — remote notifications are off for this build', {
      error: String((e as Error)?.message ?? e)
    });
    return 'unsupported';
  }
  if (!token) return 'unsupported';

  try {
    await options.register(token);
  } catch (e) {
    // Offline at launch is the ordinary case, not an error worth surfacing: the
    // next launch registers, and so does the next token rotation.
    log('could not register for push', { error: String((e as Error)?.message ?? e) });
    return 'failed';
  }
  return 'registered';
}
