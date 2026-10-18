import { copyFileSync, renameSync, rmSync } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { degrade } from './degrade';

// Put a finished temp file in place of `path`: the second half of every
// write-then-rename store.
//
// On POSIX that is one rename. On Windows a rename onto a file that anyone has
// open fails with EPERM, and the reader can be anyone: another store's read of
// the same file, the pi process reading its config, the antivirus scanning
// what was just written. A probe with one busy reader lost 246 of 300 renames,
// and each of those was a save that never landed. So Windows retries for a
// while, and when the file stays busy past that, the content is copied over it
// in place: an unlucky reader may see a torn file once, which every store
// already survives, where a dropped rename loses the user's change outright.

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_BUDGET_MS = 2_000;
const delay = (attempt: number) => Math.min(10 * 2 ** attempt, 100);
const busy = (e: unknown) => process.platform === 'win32' && BUSY.has((e as NodeJS.ErrnoException)?.code ?? '');

export async function replaceFile(tmp: string, path: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0, waited = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      if (!busy(e)) throw e;
      last = e;
      if (waited >= RETRY_BUDGET_MS) break;
      await new Promise((resolve) => setTimeout(resolve, delay(attempt)));
      waited += delay(attempt);
    }
  }
  degrade('replace-file', `${path} stayed busy, so it was overwritten in place`, last);
  await copyFile(tmp, path);
  await rm(tmp, { force: true });
}

/** replaceFile for the synchronous stores (the secret key). */
export function replaceFileSync(tmp: string, path: string): void {
  let last: unknown;
  for (let attempt = 0, waited = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      if (!busy(e)) throw e;
      last = e;
      if (waited >= RETRY_BUDGET_MS) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay(attempt));
      waited += delay(attempt);
    }
  }
  degrade('replace-file', `${path} stayed busy, so it was overwritten in place`, last);
  copyFileSync(tmp, path);
  rmSync(tmp, { force: true });
}
