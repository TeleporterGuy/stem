// One accepted scan per opening of the camera.
//
// expo-camera's onBarcodeScanned fires per FRAME, not per code: a QR held in
// view produces the same payload thirty times a second. A pairing code is
// one-shot and eight consecutive failures lock the route for fifteen minutes
// (src/server/transport/pairing.ts), so a second submission of a code that is
// already being spent is not a harmless duplicate — it is a wasted attempt
// against that lockout, answered with a 401 that arrives after the successful
// one and overwrites the screen with an error about a pairing that worked.
//
// A latch and not a piece of React state, because the guard has to hold on the
// very next frame — before any re-render could have carried a new value into the
// callback the camera is holding. `busy` state got this wrong exactly that way:
// the second frame read the closure captured with the first, in which nothing
// had happened yet.

export interface ScanLatch {
  /** True for the first caller only; false for everyone after, until reset. */
  accept(): boolean;
  /** Open the latch again — what reopening the scanner does. */
  reset(): void;
}

export function createScanLatch(): ScanLatch {
  let taken = false;
  return {
    accept(): boolean {
      if (taken) return false;
      taken = true;
      return true;
    },
    reset(): void {
      taken = false;
    }
  };
}
