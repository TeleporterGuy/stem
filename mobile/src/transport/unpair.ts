// Unpairing, in the only order that can work.
//
// Deleting the credential is the part the phone can always do. Telling the
// server to forget the phone is the part that MATTERS, and it is the part that
// stops being possible the instant the credential is gone: the revoke is
// authenticated by the very token it revokes.
//
// It matters because a device row is not just a permission. It carries the APNs
// token (src/server/ipc/devices.ts), so a server that keeps the row keeps waking
// a phone that can no longer open anything it is woken for — notifications with
// thread titles in them, arriving on a phone the user believes they disconnected.
// `devices:revoke` deletes the row, the token with it, and drops the streams.
//
// Best effort, and not waited on. The commonest reason to unpair is that the
// server is not coming back — sold, reinstalled, or simply gone — and making the
// user watch a request time out against a machine that will never answer, in
// order to unpair from it, would be the wrong way round. So the request goes out
// first, holding the endpoint it was made with, and the local half proceeds
// immediately whether or not it ever lands.

export interface UnpairSteps {
  /** This phone's own row in the server's registry, or null if there is none. */
  deviceId: string | null;
  /** `devices:revoke`. Its rejection is expected often enough to be uninteresting. */
  revoke(deviceId: string): Promise<unknown>;
  /** Drop the endpoint, the cache and the Keychain entry. Always runs. */
  forget(): Promise<void>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export async function unpairDevice(steps: UnpairSteps): Promise<void> {
  if (steps.deviceId) {
    // Not awaited: see the header. The catch is what keeps a failure from
    // surfacing as an unhandled rejection long after the screen has moved on.
    void steps.revoke(steps.deviceId).catch((e: unknown) => {
      steps.log?.('the server was not told to forget this phone', {
        error: String((e as Error)?.message ?? e)
      });
    });
  }
  await steps.forget();
}
