import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const mainAssets = [
  ['src/main/pi/stem-mcp-extension.mjs', 'dist/main/pi/stem-mcp-extension.mjs'],
  ['src/main/pi/pi-node-shim.mjs', 'dist/main/pi/pi-node-shim.mjs']
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
        // recall-mcp-server is a third: a standalone stdio MCP server spawned with
        // ELECTRON_RUN_AS_NODE (see pi/mcp-config.ts); bundling it lets it share
        // src/main/recall/search-core.ts with the main process.
        // scan-worker is a fourth: the recall cosine-scan + VACUUM utilityProcess
        // (see scan-worker-host.ts), sharing search-core/maintenance-core.
        input: {
          index: 'src/main/index.ts',
          'embed-worker': 'src/main/recall/embed-worker.ts',
          'recall-mcp-server': 'src/main/recall/mcp-server-main.ts',
          'scan-worker': 'src/main/recall/scan-worker.ts'
        },
        // transformers.js must stay external: it lazily loads onnxruntime-node's
        // native .node binary, which cannot live inside a rollup bundle. Resolved
        // from node_modules at runtime instead.
        // pi-coding-agent must stay external too: pure-ESM, exports-map-only, and
        // its dist/cli.js is spawned as a real file (plus AuthStorage relies on
        // package-relative resolution). Loaded lazily via dynamic import.
        // pdfjs-dist stays external as well: its legacy build probes optional
        // canvas packages via dynamic import, which rollup would try to resolve.
        external: ['@huggingface/transformers', '@earendil-works/pi-coding-agent', /^pdfjs-dist/],
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
        // Two HTML entries. index.html serves all three desktop windows (the URL
        // flag picks main / Quick Chat / HUD); mobile.html is the phone client,
        // which the loopback bridge serves out of this same directory (see
        // src/main/mobile/server.ts) and which has no preload behind it.
        input: {
          index: 'src/renderer/index.html',
          mobile: 'src/renderer/mobile.html'
        }
      }
    }
  }
});
