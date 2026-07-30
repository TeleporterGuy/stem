import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The module reads piHome() to place web-search.json; point it at a temp dir.
let home = '';
vi.mock('../../src/main/workspace/paths', () => ({ piHome: () => home }));

const {
  buildWebSearchContext,
  extractSources,
  webSearchConfigPath,
  writeWebSearchConfig,
  SEARCH_BACKENDS,
  WEB_SEARCH_FIELDS
} = await import('../../src/main/pi/web-search');

describe('extractSources', () => {
  // The real shape returned by pi-web-access's web_search: a synthesized answer
  // with inline markdown citations, then a numbered "**Sources:**" tail. Captured
  // from a live run against the Codex backend.
  const REAL_RESULT = [
    'Carlos Alcaraz won the 2026 Australian Open men’s singles final, defeating Novak Djokovic in four sets,',
    '2–6, 6–2, 6–3, 7–5. [Australian Open honour roll](https://ausopen.com/history/honour-roll/mens-singles)',
    '[ATP Tour recap](https://www.atptour.com/en/news/alcaraz-djokovic-australian-open-2026-final)',
    '',
    '---',
    '',
    '**Sources:**',
    '1. https://ausopen.com/history/honour-roll/mens-singles',
    '   https://ausopen.com/history/honour-roll/mens-singles',
    '',
    '2. https://www.abc.net.au/news/2026-02-01/australian-open-2026-final/106293114',
    '   https://www.abc.net.au/news/2026-02-01/australian-open-2026-final/106293114'
  ].join('\n');

  it('recovers inline citations with their titles', () => {
    const sources = extractSources(REAL_RESULT);
    expect(sources).toContainEqual({
      url: 'https://ausopen.com/history/honour-roll/mens-singles',
      title: 'Australian Open honour roll'
    });
    expect(sources).toContainEqual({
      url: 'https://www.atptour.com/en/news/alcaraz-djokovic-australian-open-2026-final',
      title: 'ATP Tour recap'
    });
  });

  it('adds bare URLs from the Sources tail that no inline citation covered', () => {
    const sources = extractSources(REAL_RESULT);
    expect(sources).toContainEqual({
      url: 'https://www.abc.net.au/news/2026-02-01/australian-open-2026-final/106293114'
    });
  });

  it('dedupes a URL cited both inline and in the tail, keeping the title', () => {
    const sources = extractSources(REAL_RESULT);
    const honourRoll = sources.filter((s) => s.url === 'https://ausopen.com/history/honour-roll/mens-singles');
    expect(honourRoll).toHaveLength(1);
    expect(honourRoll[0].title).toBe('Australian Open honour roll');
  });

  it('ignores prose URLs outside the Sources tail, which are not citations', () => {
    // Only the answer's own markdown links and the tail list count — a URL the
    // model merely mentioned mid-sentence is not a source it consulted.
    const text = 'Docs live at https://example.com/docs but I did not read them.';
    expect(extractSources(text)).toEqual([]);
  });

  it('strips punctuation that clings to a bare URL', () => {
    const text = '**Sources:**\n1. https://example.com/a.\n2. https://example.com/b,';
    expect(extractSources(text)).toEqual([{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }]);
  });

  it('returns nothing for empty or citation-free results', () => {
    expect(extractSources('')).toEqual([]);
    expect(extractSources('No results found.')).toEqual([]);
  });
});

describe('writeWebSearchConfig', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stem-websearch-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const base = { main: true, quickChat: true, provider: 'auto', credentials: {} };
  const read = (): Record<string, unknown> => JSON.parse(readFileSync(webSearchConfigPath(), 'utf8'));

  it('always pins workflow to none so no curator server or browser window starts', async () => {
    await writeWebSearchConfig(base);
    expect(read().workflow).toBe('none');
  });

  it('omits the provider for auto, so the package walks its own fallback chain', async () => {
    await writeWebSearchConfig(base);
    expect(read()).not.toHaveProperty('provider');
  });

  it('pins the provider when the user picked one', async () => {
    await writeWebSearchConfig({ ...base, provider: 'exa' });
    expect(read().provider).toBe('exa');
  });

  it('writes SearXNG under searxngBaseUrl, the name the package actually reads', async () => {
    // searxng.ts:70 reads `searxngBaseUrl`; an earlier `searxngUrl` was silently ignored.
    await writeWebSearchConfig({
      ...base,
      provider: 'searxng',
      credentials: { searxngBaseUrl: 'https://search.example.com' }
    });
    expect(read().searxngBaseUrl).toBe('https://search.example.com');
  });

  it('keeps every backend key at once, so switching backends loses nothing', async () => {
    await writeWebSearchConfig({
      ...base,
      provider: 'exa',
      credentials: { exaApiKey: 'exa-1', tavilyApiKey: 'tvly-1', braveApiKey: 'bsa-1' }
    });
    expect(read()).toMatchObject({ provider: 'exa', exaApiKey: 'exa-1', tavilyApiKey: 'tvly-1', braveApiKey: 'bsa-1' });
  });

  it('writes only recognized field names, trimmed, dropping blanks', async () => {
    await writeWebSearchConfig({
      ...base,
      credentials: { exaApiKey: '  exa-123  ', tavilyApiKey: '   ', bogusApiKey: 'nope' }
    });
    const file = read();
    expect(file.exaApiKey).toBe('exa-123');
    expect(file).not.toHaveProperty('tavilyApiKey');
    expect(file).not.toHaveProperty('bogusApiKey');
  });

  it('every backend field is one the writer accepts', async () => {
    const credentials = Object.fromEntries(WEB_SEARCH_FIELDS.map((f) => [f, `${f}-value`]));
    await writeWebSearchConfig({ ...base, credentials });
    const file = read();
    for (const field of WEB_SEARCH_FIELDS) expect(file[field]).toBe(`${field}-value`);
  });

  it('exposes a credential field for every backend that needs one', () => {
    // auto/all/searxng aside, each backend is unusable without its own field, so a
    // backend missing from WEB_SEARCH_FIELDS would be unreachable from the UI.
    for (const backend of SEARCH_BACKENDS) {
      if (backend.field) expect(WEB_SEARCH_FIELDS).toContain(backend.field);
    }
  });

  it('keeps the file owner-only — it holds the user API keys', async () => {
    await writeWebSearchConfig({ ...base, credentials: { exaApiKey: 'exa-123' } });
    expect(statSync(webSearchConfigPath()).mode & 0o077).toBe(0);
  });

  it('overwrites cleanly, so a cleared key does not linger from a previous write', async () => {
    await writeWebSearchConfig({ ...base, credentials: { exaApiKey: 'exa-123' } });
    await writeWebSearchConfig({ ...base, credentials: {} });
    expect(read()).not.toHaveProperty('exaApiKey');
  });
});

// The per-turn block that puts the search tools back in the model's view. Without
// it the injected context listed only routed MCP tools — hundreds of them, browser
// automation included — and a model asked to "check this link" reached for a
// browser because nothing nearby said web_search existed.
describe('buildWebSearchContext', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stem-websearch-ctx-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const base = { main: true, quickChat: true, provider: 'auto', credentials: {} };

  it('names every search tool the extension registers', async () => {
    await writeWebSearchConfig(base);
    const block = buildWebSearchContext(true) ?? '';
    for (const tool of ['web_search', 'fetch_content', 'source_check', 'get_search_content']) {
      expect(block).toContain(tool);
    }
  });

  it('says these are called directly, not through the MCP router', async () => {
    await writeWebSearchConfig(base);
    expect(buildWebSearchContext(true)).toContain('invoke_tool');
  });

  it('names the backend the search tools will actually use', async () => {
    await writeWebSearchConfig({ ...base, provider: 'exa' });
    expect(buildWebSearchContext(true)).toContain('backend: exa');
  });

  it('spells out the meta-backends rather than printing their ids', async () => {
    await writeWebSearchConfig(base);
    expect(buildWebSearchContext(true)).toContain('backend: automatic');
    await writeWebSearchConfig({ ...base, provider: 'all' });
    expect(buildWebSearchContext(true)).toContain('every configured backend at once');
  });

  it('re-reads the backend after the user switches it', async () => {
    await writeWebSearchConfig({ ...base, provider: 'exa' });
    expect(buildWebSearchContext(true)).toContain('backend: exa');
    await writeWebSearchConfig({ ...base, provider: 'brave' });
    expect(buildWebSearchContext(true)).toContain('backend: brave');
  });

  it('falls back to auto when the config is missing', () => {
    expect(buildWebSearchContext(true)).toContain('backend: automatic');
  });

  // The gate deactivates the tools for the turn, so advertising them would be a lie.
  it('emits nothing when web search is off for this turn', async () => {
    await writeWebSearchConfig(base);
    expect(buildWebSearchContext(false)).toBeNull();
  });
});
