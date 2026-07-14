import { afterEach, describe, expect, it, vi } from 'vitest';
import { shell } from 'electron';

const httpState = vi.hoisted(() => ({ servers: [] as Array<{ closed: boolean }> }));

vi.mock('node:http', () => ({
  createServer: () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const server = {
      closed: false,
      on(name: string, listener: (...args: unknown[]) => void) {
        listeners.set(name, listener);
        return server;
      },
      listen(_port: number, _host: string, callback: () => void) {
        callback();
        return server;
      },
      address() {
        return { port: 41759 };
      },
      close(callback?: () => void) {
        server.closed = true;
        callback?.();
        return server;
      }
    };
    httpState.servers.push(server);
    return server;
  }
}));

import { authorizeMcp } from '../../src/main/pi/oauth';

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  httpState.servers.length = 0;
});

describe('MCP OAuth deadline', () => {
  it('rejects and closes the loopback when no browser callback arrives', async () => {
    vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://mcp.test/server') {
          return new Response('', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.test/resource"' }
          });
        }
        if (url === 'https://mcp.test/resource') {
          return json({ resource: 'https://mcp.test/server', authorization_servers: ['https://auth.test'] });
        }
        if (url === 'https://auth.test/.well-known/oauth-authorization-server') {
          return json({
            authorization_endpoint: 'https://auth.test/authorize',
            token_endpoint: 'https://auth.test/token'
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    await expect(
      authorizeMcp('https://mcp.test/server', { clientId: 'static-client', timeoutMs: 20 })
    ).rejects.toThrow('timed out after 20ms');
    expect(httpState.servers).toHaveLength(1);
    expect(httpState.servers[0].closed).toBe(true);
  });

  it('aborts a hung discovery fetch under the same overall deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
      )
    );

    await expect(authorizeMcp('https://mcp.test/server', { timeoutMs: 20 })).rejects.toThrow(
      'timed out after 20ms'
    );
    expect(httpState.servers).toHaveLength(0);
  });
});
