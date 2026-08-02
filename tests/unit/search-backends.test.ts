// The Web search picker's readiness rules. These decide whether a user is told
// "this works already" or "paste a key first", so the keyless routes — Exa's MCP
// fallback and the ChatGPT sign-in — must be reported exactly as pi-web-access
// resolves them, not as a guess.
import { describe, expect, it } from 'vitest';
import {
  backendOptionLabel,
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
  it('treats the meta-backends as needing nothing, once anything is configured', () => {
    for (const id of ['auto', 'all']) {
      expect(backendState(backend(id), { braveApiKey: 'k' }, [])).toEqual({
        ready: true,
        group: 'keyless',
        status: 'nothing to set up'
      });
    }
  });

  // `auto` is the default, so this is the state most people are actually in — and
  // where it lands (Exa's free allowance) is exactly what the row does not say.
  it('warns that the meta-backends inherit the cap when no key is set anywhere', () => {
    for (const id of ['auto', 'all']) {
      const state = backendState(backend(id), {}, []);
      expect(state.ready).toBe(true);
      expect(state.capped).toBe(true);
      expect(state.status).toMatch(/Exa/);
    }
  });

  // Exa without a key is not "free", it is a shared demo allowance that resets at
  // midnight UTC. Run it out and `auto` falls through to a backend that costs an
  // inference — or, with nothing else configured, search fails outright for the
  // rest of the day. Reporting that as a plain "no key needed" is the bug.
  it('reports Exa as ready without a key, but marks the allowance as capped', () => {
    const state = backendState(backend('exa'), {}, []);
    expect(state.ready).toBe(true);
    expect(state.group).toBe('keyless');
    expect(state.capped).toBe(true);
    expect(state.status).toMatch(/add a key/i);
  });

  it('drops the cap warning once an Exa key is saved', () => {
    const state = backendState(backend('exa'), { exaApiKey: 'exa-abc' }, []);
    expect(state.ready).toBe(true);
    expect(state.capped).toBeUndefined();
    expect(state.group).toBe('configured');
  });

  it('says so in the picker row, not only in the status line below it', () => {
    // The section heading says "Works with no key", which is true and, on its own,
    // a promise Exa cannot keep. The row has to carry the caveat.
    expect(backendOptionLabel(backend('exa'), {}, [])).toMatch(/free limit, no key/);
    expect(backendOptionLabel(backend('exa'), { exaApiKey: 'exa-abc' }, [])).toBe('Exa');
    expect(backendOptionLabel(backend('brave'), {}, [])).toBe('Brave');
    expect(backendOptionLabel(backend('openai'), {}, ['openai-codex'])).toBe('ChatGPT / OpenAI');
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

  // Grok reaches the same `signin` route through pi's model registry, so the
  // status line has to name the account the user actually connected. It used to
  // say "ChatGPT" for every signin backend, which would be simply wrong here.
  it('reports Grok as ready once the xAI subscription is signed in, and names it', () => {
    const state = backendState(backend('xai'), {}, ['xai']);
    expect(state).toEqual({
      ready: true,
      group: 'keyless',
      status: 'no key needed — uses your Grok sign-in'
    });
  });

  it('reports Grok as blocked with no sign-in and no key', () => {
    expect(backendState(backend('xai'), {}, ['openai-codex'])).toEqual({
      ready: false,
      group: 'unset',
      status: 'needs a Grok sign-in or a key'
    });
  });

  it('warns that Grok searches share the chat allowance', () => {
    expect(backend('xai').note).toMatch(/same allowance as your Grok chats/);
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
    expect(credentialRequirement(backend('openai'), {}, ['openai-codex'])).toBe('(optional)');
    expect(credentialRequirement(backend('openai'), {}, [])).toMatch(/^\(optional — /);
    // Optional in the sense that search still runs, not in the sense that you can
    // leave it and forget about it.
    expect(credentialRequirement(backend('exa'), {}, [])).toMatch(/^\(optional — .*capped/);
    expect(credentialRequirement(backend('exa'), { exaApiKey: 'exa-abc' }, [])).toBe('(optional)');
  });
});
