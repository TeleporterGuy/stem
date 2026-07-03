// Settings suite — exercises the REAL settings store against the throwaway
// userData path from the electron stub. Focuses on the escapeAction field:
// persistence round-trip and the coerce fallback for missing/garbage values.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readSettings, updateEscapeAction, updateRetrievalSettings } from '../../src/main/workspace/settings';
import { settingsStorePath } from '../../src/main/workspace/paths';

const path = settingsStorePath();

beforeEach(() => {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
});
afterEach(() => {
  rmSync(path, { force: true });
});

describe('escapeAction setting', () => {
  it('defaults to off when no file exists', async () => {
    expect((await readSettings()).escapeAction).toBe('off');
  });

  it('round-trips single and twoStage through updateEscapeAction', async () => {
    expect((await updateEscapeAction('single')).escapeAction).toBe('single');
    expect((await readSettings()).escapeAction).toBe('single');
    expect((await updateEscapeAction('twoStage')).escapeAction).toBe('twoStage');
    expect((await readSettings()).escapeAction).toBe('twoStage');
    expect((await updateEscapeAction('off')).escapeAction).toBe('off');
  });

  it('falls back to off for a garbage persisted value', async () => {
    writeFileSync(path, JSON.stringify({ escapeAction: 'bogus' }));
    expect((await readSettings()).escapeAction).toBe('off');
  });

  it('falls back to off when the field is missing', async () => {
    writeFileSync(path, JSON.stringify({ quickChat: {} }));
    expect((await readSettings()).escapeAction).toBe('off');
  });
});

describe('embeddings settings migration + coercion', () => {
  it('defaults to local / multilingual-e5-small when no file exists', async () => {
    const emb = (await readSettings()).retrieval.embeddings;
    expect(emb.mode).toBe('local');
    expect(emb.localModel).toBe('multilingual-e5-small');
  });

  it('migrates a legacy enabled:true endpoint to remote, keeping its fields', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        retrieval: {
          embeddings: { baseUrl: 'http://box:9999', model: 'my-embed', apiKey: 'sk-1', enabled: true }
        }
      })
    );
    const emb = (await readSettings()).retrieval.embeddings;
    expect(emb.mode).toBe('remote');
    expect(emb.baseUrl).toBe('http://box:9999');
    expect(emb.model).toBe('my-embed');
    expect(emb.apiKey).toBe('sk-1');
  });

  it('migrates a legacy enabled:false endpoint to the local default', async () => {
    // enabled:false is indistinguishable from "never touched" (defaults persist),
    // so it takes the new local default; an explicit Off mode remains available.
    writeFileSync(
      path,
      JSON.stringify({
        retrieval: {
          embeddings: { baseUrl: 'http://localhost:11434', model: 'qwen3-embedding:8b', apiKey: null, enabled: false }
        }
      })
    );
    expect((await readSettings()).retrieval.embeddings.mode).toBe('local');
  });

  it('coerces garbage mode/localModel back to defaults', async () => {
    writeFileSync(path, JSON.stringify({ retrieval: { embeddings: { mode: 'bogus', localModel: 'bogus' } } }));
    const emb = (await readSettings()).retrieval.embeddings;
    expect(emb.mode).toBe('local');
    expect(emb.localModel).toBe('multilingual-e5-small');
  });

  it('round-trips mode and localModel through updateRetrievalSettings', async () => {
    await updateRetrievalSettings({ embeddings: { mode: 'remote' } });
    expect((await readSettings()).retrieval.embeddings.mode).toBe('remote');
    // A mode switch is a partial patch — the other fields survive.
    await updateRetrievalSettings({ embeddings: { mode: 'local', localModel: 'multilingual-e5-base' } });
    const emb = (await readSettings()).retrieval.embeddings;
    expect(emb.mode).toBe('local');
    expect(emb.localModel).toBe('multilingual-e5-base');
    expect(emb.baseUrl).toBe('http://localhost:11434');
    // Off round-trips too (it is a real persisted mode, not just absence).
    await updateRetrievalSettings({ embeddings: { mode: 'off' } });
    expect((await readSettings()).retrieval.embeddings.mode).toBe('off');
  });
});
