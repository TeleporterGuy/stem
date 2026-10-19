import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The share.heystem.app viewer (docs/public-share-design.md): a static page
// that fetches an encrypted snapshot and renders it with the app's own MDX
// renderer. Deployed as plain files behind Caddy (relay/deploy/global).
export default defineConfig({
  root: 'src/share',
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../../dist/share',
    emptyOutDir: true,
    // No inline scripts: the page's CSP is script-src 'self'.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false }
  }
});
