import { statSync } from 'node:fs';
import { expect } from 'vitest';

/**
 * Assert a file's POSIX permission bits (`mask` picks which). Windows has none
 * to assert: Node reports only 0o666 or 0o444 there, and what keeps a secret
 * owner-only is the ACL Stem's folders inherit from the user's profile.
 */
export function expectPosixMode(path: string, expected: number, mask = 0o777): void {
  if (process.platform === 'win32') return;
  expect(statSync(path).mode & mask).toBe(expected);
}
