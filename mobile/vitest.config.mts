import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Plain vitest, deliberately not jest-expo: everything under test here is a
// module with no React and no native module in it — the SSE parser, the reader's
// state machine, the RPC envelope, the pairing strings. Anything that needs a
// device (the Keychain, the camera, expo/fetch) is behind an injection point for
// exactly this reason, so the suite runs headless in Node with no simulator and
// no network.

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../src/shared', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
