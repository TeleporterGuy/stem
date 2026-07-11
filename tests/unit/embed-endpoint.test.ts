// Embed-endpoint protocol: token gating, unavailable-client fast-fail, and the
// vector roundtrip — over a real unix socket in tmpdir (pure node:net, fine in
// the forks pool). The MCP-side consumer of this protocol is exercised by
// scripts/recall-mcp-probe.mjs against the real compiled MCP server.
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getEmbedEndpointToken, startEmbedEndpoint } from '../../src/main/recall/embed-endpoint';
import type { EmbeddingsClient } from '../../src/main/recall/embeddings';

const SOCK = join(tmpdir(), `stem-embed-test-${process.pid}.sock`);

function request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCK);
    let buf = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      socket.destroy();
      resolve(JSON.parse(buf.slice(0, nl)));
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(body)}\n`));
  });
}

const goodClient: EmbeddingsClient = {
  available: async () => true,
  modelId: async () => 'fake-model',
  embed: async (texts, kind) => texts.map(() => Float32Array.from(kind === 'query' ? [1, 0] : [0, 1]))
};

let client: EmbeddingsClient | null = goodClient;
const endpoint = startEmbedEndpoint({ socketPath: SOCK, getClient: () => client });

afterAll(async () => {
  await endpoint.close();
});

describe('embed endpoint', () => {
  it('round-trips a query embedding with model + dim', async () => {
    const res = await request({ id: 7, op: 'embed', kind: 'query', texts: ['hello'], token: getEmbedEndpointToken() });
    expect(res).toEqual({ id: 7, ok: true, model: 'fake-model', dim: 2, vectors: [[1, 0]] });
  });

  it('rejects a bad token without touching the client', async () => {
    const res = await request({ id: 1, op: 'embed', kind: 'query', texts: ['x'], token: 'wrong' });
    expect(res).toMatchObject({ ok: false, error: 'bad token' });
  });

  it('rejects malformed requests (no texts / too many / wrong op)', async () => {
    const token = getEmbedEndpointToken();
    for (const bad of [
      { id: 1, op: 'embed', texts: [], token },
      { id: 2, op: 'embed', texts: Array.from({ length: 9 }, () => 'x'), token },
      { id: 3, op: 'delete', texts: ['x'], token }
    ]) {
      const res = await request(bad);
      expect(res).toMatchObject({ ok: false, error: 'bad request' });
    }
  });

  it('answers ok:false fast when embeddings are off or unavailable', async () => {
    const token = getEmbedEndpointToken();
    client = null;
    expect(await request({ id: 1, op: 'embed', texts: ['x'], token })).toMatchObject({
      ok: false,
      error: 'embeddings unavailable'
    });
    client = { ...goodClient, available: async () => false };
    expect(await request({ id: 2, op: 'embed', texts: ['x'], token })).toMatchObject({
      ok: false,
      error: 'embeddings unavailable'
    });
    client = goodClient;
  });

  it('reports an embed failure as ok:false instead of dying', async () => {
    client = {
      ...goodClient,
      embed: async () => {
        throw new Error('worker crashed');
      }
    };
    const res = await request({ id: 1, op: 'embed', texts: ['x'], token: getEmbedEndpointToken() });
    expect(res).toMatchObject({ ok: false, error: 'worker crashed' });
    client = goodClient;
  });
});
