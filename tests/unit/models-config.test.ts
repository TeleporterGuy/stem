// models.json writer for local providers (Ollama / LM Studio): URL normalizing,
// the /v1/models probe, and syncModelsConfig's write/merge semantics — including
// keeping last-known models when a probe fails and preserving hand-added
// third-party provider blocks. Runs against a throwaway models.json via the
// STEM_PI_MODELS_CONFIG env seam; fetch is stubbed per test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLocalBaseUrl, probeLocalProvider, syncModelsConfig } from '../../src/main/pi/models-config';
import type { LocalProvidersSettings } from '../../src/shared/types';

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stem-models-config-'));
  configPath = join(dir, 'models.json');
  process.env.STEM_PI_MODELS_CONFIG = configPath;
});

afterEach(() => {
  delete process.env.STEM_PI_MODELS_CONFIG;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function settings(patch?: Partial<LocalProvidersSettings>): LocalProvidersSettings {
  return {
    ollama: { enabled: false, baseUrl: 'http://localhost:11434' },
    lmstudio: { enabled: false, baseUrl: 'http://localhost:1234' },
    ...patch
  };
}

function stubModels(ids: string[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }))
  );
}

function readConfig(): { providers: Record<string, { baseUrl: string; models?: { id: string }[] }> } {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

describe('normalizeLocalBaseUrl', () => {
  it('strips trailing slashes and a trailing /v1', () => {
    expect(normalizeLocalBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(normalizeLocalBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234');
    expect(normalizeLocalBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234');
    expect(normalizeLocalBaseUrl('  http://box:8080  ')).toBe('http://box:8080');
  });
});

describe('probeLocalProvider', () => {
  it('returns sorted model ids from /v1/models', async () => {
    stubModels(['zeta', 'alpha']);
    const res = await probeLocalProvider('http://localhost:11434');
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(['alpha', 'zeta']);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://localhost:11434/v1/models');
  });

  it('rejects a non-http URL without fetching', async () => {
    const res = await probeLocalProvider('localhost:11434');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/http:\/\/localhost/);
  });

  it('reports an HTTP error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' })));
    const res = await probeLocalProvider('http://localhost:11434');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('503');
  });

  it('reports a network failure as its message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    const res = await probeLocalProvider('http://localhost:11434');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNREFUSED');
  });

  it('drops Ollama models without tool support and counts them', async () => {
    // Ollama-style server: /v1/models lists two, /api/show says only one has tools.
    const caps: Record<string, string[]> = { 'llama3.1:8b': ['completion', 'tools'], 'smollm:135m': ['completion'] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/v1/models')) {
          return new Response(JSON.stringify({ data: Object.keys(caps).map((id) => ({ id })) }), { status: 200 });
        }
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        return new Response(JSON.stringify({ capabilities: caps[model] }), { status: 200 });
      })
    );
    const res = await probeLocalProvider('http://localhost:11434');
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(['llama3.1:8b']);
    expect(res.skippedNoTools).toBe(1);
  });

  it('keeps every model when the server has no /api/show (LM Studio etc.)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/v1/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'some-gguf' }] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      })
    );
    const res = await probeLocalProvider('http://localhost:1234');
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(['some-gguf']);
    expect(res.skippedNoTools).toBeUndefined();
  });
});

describe('syncModelsConfig', () => {
  it('writes a provider block for an enabled server and reports change', async () => {
    stubModels(['llama3.1:8b', 'qwen2.5-coder:7b']);
    const changed = await syncModelsConfig(settings({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } }));
    expect(changed).toBe(true);
    const cfg = readConfig();
    expect(cfg.providers.ollama.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.providers.ollama.models).toEqual([{ id: 'llama3.1:8b' }, { id: 'qwen2.5-coder:7b' }]);
    expect(cfg.providers.ollama).toMatchObject({
      api: 'openai-completions',
      apiKey: 'local',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }
    });
    expect(cfg.providers.lmstudio).toBeUndefined();
  });

  it('is a no-op (unchanged) when nothing is enabled and no file exists', async () => {
    expect(await syncModelsConfig(settings())).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it('reports no change when a re-sync finds the same models', async () => {
    stubModels(['llama3.1:8b']);
    const s = settings({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
    expect(await syncModelsConfig(s)).toBe(true);
    expect(await syncModelsConfig(s)).toBe(false);
  });

  it('keeps last-known models when the probe fails', async () => {
    stubModels(['llama3.1:8b']);
    const s = settings({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
    await syncModelsConfig(s);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    expect(await syncModelsConfig(s)).toBe(false); // content identical → no restart needed
    expect(readConfig().providers.ollama.models).toEqual([{ id: 'llama3.1:8b' }]);
  });

  it('drops the provider block when disabled', async () => {
    stubModels(['llama3.1:8b']);
    await syncModelsConfig(settings({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } }));
    expect(await syncModelsConfig(settings())).toBe(true);
    expect(readConfig().providers.ollama).toBeUndefined();
  });

  it('preserves hand-added third-party provider blocks', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          'my-vllm': { baseUrl: 'http://box:8000/v1', api: 'openai-completions', models: [{ id: 'custom' }] }
        }
      })
    );
    stubModels(['llama3.1:8b']);
    await syncModelsConfig(settings({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } }));
    const cfg = readConfig();
    expect(cfg.providers['my-vllm'].models).toEqual([{ id: 'custom' }]);
    expect(cfg.providers.ollama).toBeDefined();
  });

  it('quarantines a corrupt models.json instead of parsing it', async () => {
    writeFileSync(configPath, '{not json');
    stubModels(['m']);
    await syncModelsConfig(settings({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } }));
    expect(readFileSync(`${configPath}.corrupt`, 'utf8')).toBe('{not json');
    expect(readConfig().providers.ollama).toBeDefined();
  });
});
