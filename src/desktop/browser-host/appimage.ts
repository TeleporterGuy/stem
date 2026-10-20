import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';

/**
 * May Stem start this AppImage as a browser? The path arrives from a native
 * host's word (browser-host/native-host-main.ts reads it from the browser's
 * APPIMAGE), and unlike the browsers in shared/browser-native.ts an AppImage
 * lives wherever the user put it. So the file itself has to vouch: a regular
 * file reached by its real path (no links), executable, with the AppImage
 * magic after the ELF header ("AI" and the type byte at offset 8). It and
 * every folder above it must be owned by this user or root and writable by
 * no one else (a root-owned sticky folder like /tmp is fine), so another
 * user cannot swap the file between this check and the launch.
 */
export function launchableAppImage(path: string): boolean {
  if (!isAbsolute(path) || normalize(path) !== path) return false;
  const uid = process.getuid?.();
  const ownedHere = (owner: number) => owner === 0 || owner === uid;
  try {
    if (realpathSync(path) !== path) return false;
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const st = lstatSync(dir);
      const sharedSticky = st.uid === 0 && (st.mode & 0o1000) !== 0;
      if (!st.isDirectory() || !ownedHere(st.uid) || ((st.mode & 0o022) !== 0 && !sharedSticky)) return false;
      if (dir === '/') break;
    }
    const fd = openSync(path, 'r');
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || !ownedHere(st.uid) || (st.mode & 0o100) === 0 || (st.mode & 0o022) !== 0) return false;
      const head = Buffer.alloc(11);
      if (readSync(fd, head, 0, 11, 0) !== 11) return false;
      return (
        head.subarray(0, 4).toString('latin1') === '\x7fELF' &&
        head.subarray(8, 10).toString('latin1') === 'AI' &&
        (head[10] === 1 || head[10] === 2)
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
