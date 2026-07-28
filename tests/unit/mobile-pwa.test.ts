// Installability. The phone client is only a Home Screen app if the browser can
// fetch the manifest and the icons it names, which makes this the most brittle
// part of the mobile story: every failure mode is silent. A renamed icon, an
// asset that never reaches dist/renderer, a manifest served as text/plain — the
// app still loads, it just quietly stops being installable.
//
// So this checks the chain end to end from source: what mobile.html asks for,
// what the manifest names, what actually sits in the public directory, and — when
// a build is present — that the same files came out the other side and are served
// with the types a browser insists on. The MIME map itself is covered from the
// transport side in mobile-bridge.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMobileServer, type MobileServer } from '../../src/main/mobile/server';

const root = fileURLToPath(new URL('../..', import.meta.url));
const publicDir = join(root, 'src/renderer/public');
const distDir = join(root, 'dist/renderer');
const html = readFileSync(join(root, 'src/renderer/mobile.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf8')) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string }[];
};

/** Every root-absolute asset mobile.html pulls in (Vite rewrites these to `./`). */
function referencedAssets(): string[] {
  return [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);
}

/** A PNG's pixel dimensions, straight out of the IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('what mobile.html asks for', () => {
  it('references only assets that exist in the public directory', () => {
    const referenced = referencedAssets();
    // The manifest, the apple-touch-icon and the favicon — if any of these three
    // stops being linked, iOS quietly falls back to a screenshot icon.
    expect(referenced).toContain('/manifest.webmanifest');
    expect(referenced).toContain('/icons/stem-180.png');
    for (const asset of referenced) {
      expect(`${asset} exists`).toBe(
        `${asset} ${statSync(join(publicDir, asset)).isFile() ? 'exists' : 'is missing'}`
      );
    }
  });

  it('restates the parts of the manifest iOS ignores', () => {
    // A Home Screen web app on iOS reads almost none of the manifest: without
    // these it opens in a Safari tab with a screenshot for an icon.
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/icons\/stem-180\.png"/);
    expect(html).toMatch(/name="apple-mobile-web-app-capable" content="yes"/);
    expect(html).toMatch(/name="apple-mobile-web-app-title" content="Stem"/);
    expect(html).toMatch(/name="apple-mobile-web-app-status-bar-style"/);
    // …and the viewport bits the phone layout depends on.
    expect(html).toMatch(/viewport-fit=cover/);
  });
});

describe('the manifest', () => {
  it('describes a standalone app rooted at the phone client', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/mobile.html');
    expect(manifest.scope).toBe('/');
    expect(manifest.name).toBe('Stem');
    // Stem's paper, so the install splash isn't a white flash of someone else's.
    expect(manifest.background_color).toBe('#f6f4ef');
    expect(manifest.theme_color).toBe('#f6f4ef');
  });

  it('names icons that exist, at the sizes it claims', () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) {
      const path = join(publicDir, icon.src);
      expect(`${icon.src} exists`).toBe(`${icon.src} ${existsSync(path) ? 'exists' : 'is missing'}`);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(path)).toEqual({ width: w, height: h });
      expect(icon.type).toBe('image/png');
    }
    // 192 and 512 are the two every install prompt wants; 180 is iOS's.
    expect(manifest.icons.map((i) => i.sizes).sort()).toEqual(['180x180', '192x192', '512x512']);
  });

  it('ships opaque icons — iOS composites an apple-touch-icon over black', () => {
    // A transparent rounded-corner icon gets black corners on the Home Screen,
    // which is why these are generated full-bleed. Colour type 2 (truecolour, no
    // alpha) or 0 (greyscale); 4 and 6 carry an alpha channel.
    for (const icon of manifest.icons) {
      const buf = readFileSync(join(publicDir, icon.src));
      expect([0, 2]).toContain(buf.readUInt8(25)); // IHDR colour type
    }
  });
});

// A production build is not guaranteed to be present (a fresh checkout has no
// dist/), so this half is conditional — but when it can run, it is the check that
// matters: everything above passing while dist/renderer is empty is exactly the
// failure this file exists to catch.
describe.skipIf(!existsSync(join(distDir, 'mobile.html')))('a production build', () => {
  let server: MobileServer;
  let base: string;

  beforeAll(async () => {
    server = await startMobileServer({
      port: 0,
      rendererDir: distDir,
      verifyToken: () => false, // nothing here is token-gated; /rpc is unreachable
      dispatch: async () => null
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server.close();
  });

  it('emitted the manifest and every icon into dist/renderer', () => {
    expect(existsSync(join(distDir, 'manifest.webmanifest'))).toBe(true);
    for (const icon of manifest.icons) {
      expect(`${icon.src} built`).toBe(
        `${icon.src} ${existsSync(join(distDir, icon.src)) ? 'built' : 'MISSING FROM dist/renderer'}`
      );
    }
  });

  it('serves them over the bridge with the right content types', async () => {
    const cases: [string, RegExp][] = [
      ['/mobile.html', /^text\/html/],
      ['/', /^text\/html/],
      ['/manifest.webmanifest', /^application\/manifest\+json/],
      ['/icons/stem-180.png', /^image\/png$/],
      ['/icons/stem-192.png', /^image\/png$/],
      ['/icons/stem-512.png', /^image\/png$/]
    ];
    for (const [path, type] of cases) {
      const res = await fetch(`${base}${path}`);
      expect(`${path} → ${res.status}`).toBe(`${path} → 200`);
      expect(res.headers.get('content-type')).toMatch(type);
    }
  });

  it('kept the manifest link resolvable from the served page', async () => {
    // Vite rewrites the root-absolute hrefs to `./…` for the desktop's file://
    // window; from /mobile.html those still resolve to /manifest.webmanifest, and
    // from / they resolve there too. Both are the paths the phone uses.
    const page = await (await fetch(`${base}/mobile.html`)).text();
    for (const href of [...page.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1])) {
      expect(`${href} → ${(await fetch(`${base}/${href}`)).status}`).toBe(`${href} → 200`);
    }
  });
});
