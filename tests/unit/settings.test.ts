// Settings suite — exercises the REAL settings store against the throwaway
// userData path from the electron stub. Focuses on the escapeAction field:
// persistence round-trip and the coerce fallback for missing/garbage values.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  markOnboardingCompleted,
  readSettings,
  updateChatsSettings,
  updateDefaultModel,
  updateEscapeAction,
  updateExecSettings,
  updateLocalProvider,
  updateQuickChat,
  updateRetrievalSettings
} from '../../src/server/workspace/settings';
import { settingsStorePath } from '../../src/server/workspace/paths';

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

describe('onboarding + default-model settings', () => {
  it('defaults to not-completed and no default model', async () => {
    const s = await readSettings();
    expect(s.onboarding.completed).toBe(false);
    expect(s.defaults.model).toBeNull();
  });

  it('markOnboardingCompleted persists', async () => {
    expect((await markOnboardingCompleted()).onboarding.completed).toBe(true);
    expect((await readSettings()).onboarding.completed).toBe(true);
  });

  it('updateDefaultModel round-trips and clears back to null', async () => {
    expect((await updateDefaultModel('anthropic/claude-sonnet-4')).defaults.model).toBe('anthropic/claude-sonnet-4');
    expect((await readSettings()).defaults.model).toBe('anthropic/claude-sonnet-4');
    expect((await updateDefaultModel(null)).defaults.model).toBeNull();
  });

  it('coerces garbage values back to defaults', async () => {
    writeFileSync(path, JSON.stringify({ onboarding: { completed: 'yes' }, defaults: { model: 42 } }));
    const s = await readSettings();
    expect(s.onboarding.completed).toBe(false);
    expect(s.defaults.model).toBeNull();
  });
});

describe('the fields a machine owns rather than Stem', () => {
  // The Quick Chat hotkey, the overlay's two visibility flags and the whole
  // "what's new" block moved to client.json in Phase 2 (see client-settings.test.ts).
  // What settings.json must still do is read a file that has them without
  // tripping, and stop carrying them forward — a settings.json written before the
  // split is what every existing install has.
  const LEGACY = {
    quickChat: {
      shortcut: 'Alt+Space',
      showOnAllDisplays: false,
      followAcrossSpaces: false,
      defaultEffort: 'high'
    },
    releaseNotes: { showOnUpdate: false, lastSeenVersion: '0.2.0' }
  };

  it('parses a pre-split settings.json and keeps the fields that are still Stem\'s', async () => {
    writeFileSync(path, JSON.stringify(LEGACY));
    const s = await readSettings();
    expect(s.quickChat.defaultEffort).toBe('high');
    expect(s).not.toHaveProperty('releaseNotes');
    expect(Object.keys(s.quickChat).sort()).toEqual([
      'defaultEffort',
      'defaultModel',
      'defaultServiceTier',
      'finishSound',
      'newThreadTimeoutMs'
    ]);
  });

  it('sheds them on the next write instead of persisting a value nobody reads', async () => {
    writeFileSync(path, JSON.stringify(LEGACY));
    await updateEscapeAction('single');
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk.releaseNotes).toBeUndefined();
    expect(onDisk.quickChat).not.toHaveProperty('shortcut');
  });

  it('accepts a patch carrying them and simply does not store them', async () => {
    // The client sends the user's whole Quick Chat patch; deciding what belongs
    // in this file is `coerce`'s job and nobody else's.
    const next = await updateQuickChat({ shortcut: 'Alt+Space', finishSound: true });
    expect(next.quickChat.finishSound).toBe(true);
    expect(next.quickChat).not.toHaveProperty('shortcut');
  });

  it('no longer touches the seen-marker when onboarding completes', async () => {
    // The marker is a client's now — the version it records is the version
    // installed on that machine — so the seeding rides the same channel from the
    // other side of the wire.
    const s = await markOnboardingCompleted();
    expect(s.onboarding.completed).toBe(true);
    expect(s).not.toHaveProperty('releaseNotes');
  });
});

describe('local provider settings', () => {
  it('defaults to disabled with the servers\' standard URLs', async () => {
    const lp = (await readSettings()).localProviders;
    expect(lp.ollama).toEqual({ enabled: false, baseUrl: 'http://localhost:11434' });
    expect(lp.lmstudio).toEqual({ enabled: false, baseUrl: 'http://localhost:1234' });
    // The custom endpoint has no standard URL — the user supplies one.
    expect(lp.custom).toEqual({ enabled: false, baseUrl: '' });
  });

  it('round-trips a custom endpoint with a key and hand-entered model ids', async () => {
    await updateLocalProvider('custom', {
      enabled: true,
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-secret',
      models: [' gpt-4o-ish ', '', 'llama-70b']
    });
    expect((await readSettings()).localProviders.custom).toEqual({
      enabled: true,
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-secret',
      models: ['gpt-4o-ish', 'llama-70b'] // trimmed, blanks dropped
    });
    // Re-adding without a key clears the old one rather than inheriting it.
    await updateLocalProvider('custom', { apiKey: '', models: [] });
    expect((await readSettings()).localProviders.custom).toEqual({
      enabled: true,
      baseUrl: 'https://gw.example.com/v1'
    });
  });

  it('round-trips the anthropic-messages flavor on the custom endpoint', async () => {
    await updateLocalProvider('custom', {
      enabled: true,
      baseUrl: 'http://proxy.example:9999/anthropic/v1',
      api: 'anthropic-messages',
      apiKey: 'sk-secret',
      models: ['anthropic--claude-4.8-opus']
    });
    expect((await readSettings()).localProviders.custom).toEqual({
      enabled: true,
      baseUrl: 'http://proxy.example:9999/anthropic/v1',
      api: 'anthropic-messages',
      apiKey: 'sk-secret',
      models: ['anthropic--claude-4.8-opus']
    });
  });

  it('round-trips the openai-completions flavor on the custom endpoint (persisted verbatim, not defaulted-away)', async () => {
    // Two states must be distinguishable in a saved settings.json:
    //  - `api: 'openai-completions'` — user hand-picked OpenAI Chat Completions.
    //  - api field absent — the provider hasn't been through the new flavored
    //    Enable path (older Stem build, or fresh state).
    // Both fall back to the openai-completions default downstream, but the
    // persisted form differs so a future debug read can tell them apart.
    await updateLocalProvider('custom', {
      enabled: true,
      baseUrl: 'http://proxy.example:9999/openai/v1',
      api: 'openai-completions',
      apiKey: 'sk-secret',
      models: ['gpt-x']
    });
    expect((await readSettings()).localProviders.custom).toEqual({
      enabled: true,
      baseUrl: 'http://proxy.example:9999/openai/v1',
      api: 'openai-completions',
      apiKey: 'sk-secret',
      models: ['gpt-x']
    });
  });

  it('strips the api field for ollama/lmstudio (hand-edited settings.json cannot force it)', async () => {
    // Only `custom` may opt into anthropic-messages; a hand-edited settings.json
    // trying to set it on ollama must round-trip without the field.
    await updateLocalProvider('ollama', {
      enabled: true,
      baseUrl: 'http://localhost:11434',
      api: 'anthropic-messages' as never
    });
    expect((await readSettings()).localProviders.ollama).toEqual({
      enabled: true,
      baseUrl: 'http://localhost:11434'
    });
  });

  it('round-trips enable + custom URL per provider independently', async () => {
    await updateLocalProvider('ollama', { enabled: true, baseUrl: 'http://box:11434' });
    const lp = (await readSettings()).localProviders;
    expect(lp.ollama).toEqual({ enabled: true, baseUrl: 'http://box:11434' });
    expect(lp.lmstudio.enabled).toBe(false);
    // partial patch keeps the other field
    await updateLocalProvider('ollama', { enabled: false });
    expect((await readSettings()).localProviders.ollama).toEqual({ enabled: false, baseUrl: 'http://box:11434' });
  });

  it('coerces garbage values back to defaults', async () => {
    writeFileSync(path, JSON.stringify({ localProviders: { ollama: { enabled: 'yes', baseUrl: 42 }, bogus: {} } }));
    const lp = (await readSettings()).localProviders;
    expect(lp.ollama).toEqual({ enabled: false, baseUrl: 'http://localhost:11434' });
    expect(Object.keys(lp).sort()).toEqual(['custom', 'lmstudio', 'ollama']);
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

describe('reranker settings migration + coercion', () => {
  it('defaults to off / bge-reranker-v2-m3 when no file exists', async () => {
    const rr = (await readSettings()).retrieval.reranker;
    expect(rr.mode).toBe('off');
    expect(rr.localModel).toBe('bge-reranker-v2-m3');
  });

  it('migrates a legacy enabled:true endpoint to remote, keeping its fields', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        retrieval: {
          reranker: { baseUrl: 'http://box:8012', model: 'my-reranker', apiKey: 'sk-2', enabled: true }
        }
      })
    );
    const rr = (await readSettings()).retrieval.reranker;
    expect(rr.mode).toBe('remote');
    expect(rr.baseUrl).toBe('http://box:8012');
    expect(rr.model).toBe('my-reranker');
    expect(rr.apiKey).toBe('sk-2');
  });

  it('migrates a legacy enabled:false endpoint to off (the rerank stage is opt-in)', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        retrieval: { reranker: { baseUrl: 'http://localhost:8080', model: '', apiKey: null, enabled: false } }
      })
    );
    expect((await readSettings()).retrieval.reranker.mode).toBe('off');
  });

  it('coerces garbage mode/localModel back to defaults and round-trips local mode', async () => {
    writeFileSync(path, JSON.stringify({ retrieval: { reranker: { mode: 'bogus', localModel: 'bogus' } } }));
    let rr = (await readSettings()).retrieval.reranker;
    expect(rr.mode).toBe('off');
    expect(rr.localModel).toBe('bge-reranker-v2-m3');
    await updateRetrievalSettings({ reranker: { mode: 'local' } });
    rr = (await readSettings()).retrieval.reranker;
    expect(rr.mode).toBe('local');
    expect(rr.localModel).toBe('bge-reranker-v2-m3');
  });
});

describe('exec settings', () => {
  it('defaults to enabled + assisted with an auto judge and an empty allowlist', async () => {
    const exec = (await readSettings()).exec;
    expect(exec).toEqual({ enabled: true, approvalMode: 'assisted', judgeModel: null, allowlist: [] });
  });

  it('round-trips a patch through updateExecSettings', async () => {
    const next = await updateExecSettings({ enabled: false, judgeModel: 'anthropic/claude-haiku-4' });
    expect(next.exec.enabled).toBe(false);
    expect(next.exec.judgeModel).toBe('anthropic/claude-haiku-4');
    const grown = await updateExecSettings({ allowlist: ['git push', 'npm'], approvalMode: 'yolo' });
    expect(grown.exec.allowlist).toEqual(['git push', 'npm']);
    expect(grown.exec.approvalMode).toBe('yolo');
    expect((await readSettings()).exec.enabled).toBe(false);
  });

  it('coerces a garbage allowlist: drops non-strings/empties, trims, dedupes', async () => {
    writeFileSync(
      path,
      JSON.stringify({ exec: { enabled: 'yes', judgeModel: '  ', allowlist: ['git push ', 'git push', 7, '', null] } })
    );
    const exec = (await readSettings()).exec;
    expect(exec.enabled).toBe(true);
    expect(exec.judgeModel).toBeNull();
    expect(exec.allowlist).toEqual(['git push']);
  });

  it('coerces an unknown approval mode back to assisted', async () => {
    writeFileSync(path, JSON.stringify({ exec: { approvalMode: 'chaotic-evil' } }));
    expect((await readSettings()).exec.approvalMode).toBe('assisted');
    writeFileSync(path, JSON.stringify({ exec: { approvalMode: 'manual' } }));
    expect((await readSettings()).exec.approvalMode).toBe('manual');
  });
});

describe('chats settings', () => {
  it('defaults to writing subjects everywhere, on the backend model, with two preview lines', async () => {
    expect((await readSettings()).chats).toEqual({
      subjects: 'everywhere',
      subjectModel: null,
      previewLines: 2
    });
  });

  it('round-trips a patch through updateChatsSettings', async () => {
    const next = await updateChatsSettings({ subjects: 'inbox', subjectModel: 'anthropic/claude-haiku-4' });
    expect(next.chats.subjects).toBe('inbox');
    expect(next.chats.subjectModel).toBe('anthropic/claude-haiku-4');
    // A later patch must not reset the fields it doesn't mention.
    const lines = await updateChatsSettings({ previewLines: 0 });
    expect(lines.chats.previewLines).toBe(0);
    expect(lines.chats.subjects).toBe('inbox');
    expect((await readSettings()).chats.previewLines).toBe(0);
  });

  it('keeps every valid previewLines value, including the one that equals the default', async () => {
    for (const n of [0, 1, 2] as const) {
      writeFileSync(path, JSON.stringify({ chats: { previewLines: n } }));
      expect((await readSettings()).chats.previewLines).toBe(n);
    }
  });

  it('coerces junk back to the defaults rather than to off', async () => {
    // A settings.json written by an older build has no `chats` at all; silently
    // switching the feature off for those users is the wrong failure direction.
    writeFileSync(path, JSON.stringify({ chats: { subjects: 'sometimes', subjectModel: '  ', previewLines: 9 } }));
    expect((await readSettings()).chats).toEqual({
      subjects: 'everywhere',
      subjectModel: null,
      previewLines: 2
    });
  });
});

