// The Web search picker's readiness rules. These decide whether a user is told
// "this works already" or "paste a key first", so the keyless routes — Exa's MCP
// fallback and the ChatGPT sign-in — must be reported exactly as pi-web-access
// resolves them, not as a guess.
import { describe, expect, it } from 'vitest';
import {
  backendSections,
  backendState,
  credentialLabel,
  credentialRequirement,
  SEARCH_BACKENDS
} from '../../src/renderer/manage/searchBackends';

const backend = (id: string) => {
  const b = SEARCH_BACKENDS.find((x) => x.id === id);
  if (!b) throw new Error(`no backend ${id}`);
  return b;
};

describe('search backend readiness', () => {
  it('treats the meta-backends as needing nothing', () => {
    for (const id of ['auto', 'all']) {
      expect(backendState(backend(id), {}, [])).toEqual({
        ready: true,
        group: 'keyless',
        status: 'nothing to set up'
      });
    }
  });

  it('reports Exa as ready with no key, because it falls back to Exa MCP', () => {
    expect(backendState(backend('exa'), {}, [])).toEqual({
      ready: true,
      group: 'keyless',
      status: 'no key needed'
    });
  });

  it('reports ChatGPT as ready once the subscription is signed in, with no key', () => {
    const state = backendState(backend('openai'), {}, ['openai-codex']);
    expect(state.ready).toBe(true);
    // A sign-in is not a key, so it must land with the keyless backends.
    expect(state.group).toBe('keyless');
    expect(state.status).toMatch(/ChatGPT sign-in/);
  });

  // pi-web-access walks openai-codex first and a plain `openai` key second, both
  // through pi's model registry — so either connected provider covers it.
  it('accepts a plain OpenAI provider for the same keyless route', () => {
    expect(backendState(backend('openai'), {}, ['openai']).ready).toBe(true);
  });

  it('reports ChatGPT as blocked with no sign-in and no key', () => {
    expect(backendState(backend('openai'), {}, ['anthropic', 'ollama'])).toEqual({
      ready: false,
      group: 'unset',
      status: 'needs a ChatGPT sign-in or a key'
    });
  });

  it('lets a pasted key stand in for the sign-in', () => {
    expect(backendState(backend('openai'), { openaiApiKey: 'sk-1' }, [])).toEqual({
      ready: true,
      group: 'configured',
      status: 'key saved'
    });
  });

  it('ignores a whitespace-only credential', () => {
    expect(backendState(backend('brave'), { braveApiKey: '   ' }, []).ready).toBe(false);
  });

  it('asks for an endpoint, not a key, for SearXNG', () => {
    expect(backendState(backend('searxng'), {}, []).status).toBe('needs an endpoint');
    expect(backendState(backend('searxng'), { searxngBaseUrl: 'https://s.example' }, [])).toEqual({
      ready: true,
      group: 'configured',
      status: 'endpoint saved'
    });
  });

  it('marks every keyed backend as unready until its own key is set', () => {
    const keyed = SEARCH_BACKENDS.filter((b) => b.need === 'required');
    expect(keyed.length).toBeGreaterThan(0);
    for (const b of keyed) expect(backendState(b, {}, ['openai-codex']).ready).toBe(false);
  });
});

describe('picker sections', () => {
  const ids = (sections: ReturnType<typeof backendSections>, label: string) =>
    sections.find((s) => s.label === label)?.backends.map((b) => b.id);

  it('shows only the keyless and unset sections on a fresh install', () => {
    const sections = backendSections({}, []);
    expect(sections.map((s) => s.label)).toEqual(['Works with no key', 'Not set up yet']);
    expect(ids(sections, 'Works with no key')).toEqual(['auto', 'all', 'exa']);
    expect(ids(sections, 'Not set up yet')).toContain('openai');
  });

  it('moves ChatGPT into the keyless section once you sign in', () => {
    const sections = backendSections({}, ['openai-codex']);
    expect(ids(sections, 'Works with no key')).toEqual(['auto', 'all', 'openai', 'exa']);
    expect(ids(sections, 'Not set up yet')).not.toContain('openai');
  });

  it('collects keyed backends under Configured as their keys arrive', () => {
    const sections = backendSections({ braveApiKey: 'BSA-1', tavilyApiKey: 'tvly-1' }, []);
    expect(ids(sections, 'Configured')).toEqual(['brave', 'tavily']);
    expect(ids(sections, 'Not set up yet')).not.toContain('brave');
  });

  it('lists every backend exactly once, whatever the configuration', () => {
    for (const [creds, provs] of [
      [{}, []],
      [{ exaApiKey: 'e', searxngBaseUrl: 'https://s' }, ['openai-codex']]
    ] as [Record<string, string>, string[]][]) {
      const listed = backendSections(creds, provs).flatMap((s) => s.backends.map((b) => b.id));
      expect([...listed].sort()).toEqual(SEARCH_BACKENDS.map((b) => b.id).sort());
    }
  });
});

describe('key list annotations', () => {
  it('names the credential after what it actually is', () => {
    expect(credentialLabel(backend('exa'))).toBe('Exa key');
    expect(credentialLabel(backend('searxng'))).toBe('SearXNG endpoint');
  });

  it('calls a key optional only when something else already unlocks the backend', () => {
    expect(credentialRequirement(backend('brave'), {}, [])).toBe('(required)');
    expect(credentialRequirement(backend('exa'), {}, [])).toBe('(optional)');
    expect(credentialRequirement(backend('openai'), {}, ['openai-codex'])).toBe('(optional)');
    expect(credentialRequirement(backend('openai'), {}, [])).toMatch(/^\(optional — /);
  });
});
