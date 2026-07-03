import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const mainAssets = [
  ['src/main/pi/stem-mcp-extension.mjs', 'dist/main/pi/stem-mcp-extension.mjs'],
  ['src/main/recall/mcp-server.mjs', 'dist/main/recall/mcp-server.mjs']
] as const;

function copyMainRuntimeAssets() {
  return {
    name: 'copy-main-runtime-assets',
    writeBundle(): void {
      for (const [src, dest] of mainAssets) {
        const to = join(rootDir, dest);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(rootDir, src), to);
      }
    }
  };
}

export default defineConfig({
  main: {
    plugins: [copyMainRuntimeAssets()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        // embed-worker is a second entry: it runs in its own utilityProcess
        // (utilityProcess.fork(dist/main/embed-worker.js) in embed-worker-host.ts).
        input: { index: 'src/main/index.ts', 'embed-worker': 'src/main/recall/embed-worker.ts' },
        // transformers.js must stay external: it lazily loads onnxruntime-node's
        // native .node binary, which cannot live inside a rollup bundle. Resolved
        // from node_modules at runtime instead.
        // pi-coding-agent must stay external too: pure-ESM, exports-map-only, and
        // its dist/cli.js is spawned as a real file (plus AuthStorage relies on
        // package-relative resolution). Loaded lazily via dynamic import.
        external: ['@huggingface/transformers', '@earendil-works/pi-coding-agent'],
        // Multi-input builds default to hashed names; package.json main expects
        // dist/main/index.js, so pin entry names.
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: 'src/preload/index.ts',
        // Sandboxed preloads must be CommonJS (no ESM import at runtime).
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    }
  }
});
