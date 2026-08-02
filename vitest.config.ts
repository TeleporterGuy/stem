import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit/integration layer: runs the REAL main-process modules under Node, with a
// tiny `electron` stub so they import cleanly outside the Electron runtime.
// `forks` pool gives each test file its own process — needed for node:sqlite and
// for the per-process throwaway DB path in setup-unit.ts.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup-unit.ts'],
    pool: 'forks',
    environment: 'node',
    server: {
      deps: {
        // pi-web-access ships TypeScript sources (pi loads them through its own
        // loader). Node refuses to strip types under node_modules, so the search
        // fan-out under test has to go through vite's transform, not be
        // externalized like a normal dependency.
        inline: [/pi-web-access/]
      }
    }
  },
  resolve: {
    alias: {
      electron: fileURLToPath(new URL('./tests/electron-stub.ts', import.meta.url))
    }
  }
});
