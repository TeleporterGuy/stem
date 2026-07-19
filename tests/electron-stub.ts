// Minimal `electron` stand-in for Vitest. The main-process modules under test
// (workspace/paths, files/store, …) import a couple of Electron symbols at load
// time, but the code paths the unit tests exercise never actually touch them —
// paths.ts only calls app.getPath() when the STEM_* env overrides are unset (the
// setup file always sets them), and shell is only used by revealFiles().
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const app = {
  getPath: (name: string) => join(tmpdir(), 'stem-vitest-userdata', name),
  getAppPath: () => process.cwd()
};

export const shell = {
  showItemInFolder: () => {},
  openPath: async () => '',
  // provider-auth opens the OAuth page in the system browser.
  openExternal: async () => {}
};

// Reversible fake for pi/secrets.ts: real safeStorage wraps via the OS keychain;
// the stub just tags the plaintext so tests exercise the full encrypted-at-rest
// code path (key wrap/unwrap, envelope files, field ciphertexts) deterministically.
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`stub-wrapped:${plain}`, 'utf8'),
  decryptString: (wrapped: Buffer) => {
    const text = wrapped.toString('utf8');
    if (!text.startsWith('stub-wrapped:')) throw new Error('not stub-wrapped ciphertext');
    return text.slice('stub-wrapped:'.length);
  }
};

export default { app, shell, safeStorage };
