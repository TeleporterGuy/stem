import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { piExtensionPath } from '../../src/server/pi/mcp-config';
import { recallMcpServerPath } from '../../src/server/recall/register-mcp';

describe('main runtime asset paths', () => {
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
