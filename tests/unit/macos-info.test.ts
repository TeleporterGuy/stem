import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  NS_LOCAL_NETWORK_USAGE_DESCRIPTION,
  NS_LOCAL_NETWORK_USAGE_KEY
} from '../../scripts/macos-info.mjs';
import { applyPlistKeys } from '../../scripts/brand-electron-dev.mjs';
import { LOCAL_NETWORK_DENIED_HINT } from '../../src/shared/macos-local-network';

const ROOT = join(__dirname, '../..');

describe('macOS Local Network usage description', () => {
  it('is the same sentence in electron-builder.yml and macos-info.mjs', () => {
    const cfg = parse(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')) as {
      afterPack?: string;
      mac?: { extendInfo?: Record<string, string> };
    };
    expect(cfg.mac?.extendInfo?.[NS_LOCAL_NETWORK_USAGE_KEY]).toBe(NS_LOCAL_NETWORK_USAGE_DESCRIPTION);
    expect(cfg.afterPack).toBe('scripts/after-pack.mjs');
  });

  it('is applied by the dev Electron brand script', () => {
    const src = readFileSync(join(ROOT, 'scripts/brand-electron-dev.mjs'), 'utf8');
    expect(src).toContain("from './macos-info.mjs'");
    expect(src).toContain('NS_LOCAL_NETWORK_USAGE_KEY');
    expect(src).toContain('adhocSignApp');
    expect(src).toContain('xattr');
  });

  it('is branded after Electron is downloaded, not only on npm run dev', () => {
    const src = readFileSync(join(ROOT, 'scripts/ensure-electron.mjs'), 'utf8');
    expect(src).toContain('scripts/brand-electron-dev.mjs');
  });

  it('is named in the pi MCP bridge so unpinned uvx failures are not "no route"', () => {
    const src = readFileSync(join(ROOT, 'src/server/pi/stem-mcp-extension.mjs'), 'utf8');
    expect(src).toContain(LOCAL_NETWORK_DENIED_HINT);
    expect(src).toContain('probeLanTargets');
  });

  it.skipIf(process.platform !== 'darwin')('writes the key onto a real Info.plist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stem-plist-'));
    const plist = join(dir, 'Info.plist');
    await writeFile(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Electron</string>
</dict>
</plist>
`
    );
    applyPlistKeys(plist, {
      CFBundleName: 'Stem',
      [NS_LOCAL_NETWORK_USAGE_KEY]: NS_LOCAL_NETWORK_USAGE_DESCRIPTION
    });
    const xml = await readFile(plist, 'utf8');
    expect(xml).toContain(NS_LOCAL_NETWORK_USAGE_KEY);
    expect(xml).toContain(NS_LOCAL_NETWORK_USAGE_DESCRIPTION);
    expect(xml).toContain('Stem');
    await rm(dir, { recursive: true, force: true });
  });
});
