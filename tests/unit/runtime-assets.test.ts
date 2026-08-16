import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { piExtensionPath } from '../../src/server/pi/mcp-config';
import { recallMcpServerPath } from '../../src/server/recall/register-mcp';

describe('main runtime asset paths', () => {
  // Several modules in the main bundle locate a sibling build artifact relative
  // to `import.meta.url`: the embed and scan worker hosts, register-mcp,
  // locate.ts's pi-node-shim, mcp-config's bridge extension. That join is only
  // correct while every module of the main bundle sits directly in dist/main.
  //
  // Rollup does not guarantee that on its own. It emits shared chunks into a
  // chunks/ SUBDIRECTORY by default, and a module is hoisted into one as soon as
  // two entries import it — which is exactly what adding the standalone
  // src/server/main.ts entry did. From dist/main/chunks/ every one of those joins
  // resolves one directory too deep, and it fails at runtime, on a path no test
  // reaches, with an ERR_MODULE_NOT_FOUND naming a file nobody ever wrote.
  //
  // So the flat chunk layout is a runtime invariant, not a formatting choice, and
  // it is asserted at its source: the config that could silently give it up.
  it('keeps shared chunks flat in dist/main, where sibling joins resolve', () => {
    const config = readFileSync(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8');
    const chunkNames = /chunkFileNames:\s*'([^']+)'/.exec(config)?.[1];
    expect(chunkNames, 'the main build must pin chunkFileNames').toBeTruthy();
    expect(chunkNames).not.toContain('/');
  });

  it('resolves the pi bridge extension from the source tree in unit/dev mode', () => {
    const path = piExtensionPath();
    expect(path.endsWith('src/server/pi/stem-mcp-extension.mjs')).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('resolves the recall MCP server as a sibling of the running module', () => {
    // The server is a bundled electron-vite entry: at runtime this resolves to
    // dist/main/recall-mcp-server.js. There is no source fallback (a lone .ts
    // can't be spawned), so only the path shape is assertable from unit tests.
    const path = recallMcpServerPath();
    expect(path.endsWith('recall-mcp-server.js')).toBe(true);
  });
});
