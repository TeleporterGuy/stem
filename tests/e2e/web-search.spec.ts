// Real UI clicks through the Web search settings. Search moved from an
// openai-codex-only request-body injection to the vendored pi-web-access
// extension, which works on every provider — so the per-context toggles must no
// longer hide themselves, and the backend/key configuration must actually be
// reachable. Both are DOM-level facts a unit test cannot check.
import { test, expect } from './electron';

test('the Settings tab exposes the web-search backend picker', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Settings', exact: true }).click();

  const backend = mainWindow.getByLabel('Search backend', { exact: true });
  await expect(backend).toBeVisible();
  // Defaults to the keyless chain, so a fresh install searches with no setup.
  await expect(backend).toHaveValue('auto');
});

test('picking a keyed backend reveals its key field and persists', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Settings', exact: true }).click();

  const backend = mainWindow.getByLabel('Search backend', { exact: true });
  await backend.selectOption('tavily');
  await expect(mainWindow.getByLabel('Tavily key', { exact: true }).first()).toBeVisible();

  const saved = await mainWindow.evaluate(() =>
    (window as unknown as { stem: { getSettings(): Promise<{ webSearch: { provider: string } }> } }).stem
      .getSettings()
      .then((s) => s.webSearch.provider)
  );
  expect(saved).toBe('tavily');
});

test('SearXNG offers an endpoint field, not an API key', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Settings', exact: true }).click();

  await mainWindow.getByLabel('Search backend', { exact: true }).selectOption('searxng');
  await expect(mainWindow.getByLabel('SearXNG endpoint', { exact: true }).first()).toBeVisible();
});

test('every backend is selectable, independent of the chat model', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Settings', exact: true }).click();

  const values = await mainWindow.getByLabel('Search backend', { exact: true }).evaluate((el) =>
    [...(el as HTMLSelectElement).options].map((o) => o.value)
  );
  expect(values).toEqual([
    'auto',
    'all',
    'openai',
    'exa',
    'brave',
    'tavily',
    'perplexity',
    'gemini',
    'parallel',
    'tinyfish',
    'serpdive',
    'anysearch',
    'searxng'
  ]);
});

test('all backend keys are editable at once and survive a backend switch', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Settings', exact: true }).click();
  await mainWindow.getByRole('button', { name: /all backend keys/ }).click();

  // Two different backends' keys, entered while a third is selected.
  await mainWindow.getByLabel('Exa key', { exact: true }).fill('exa-key-1');
  await mainWindow.getByLabel('Brave key', { exact: true }).fill('brave-key-1');
  await mainWindow.getByLabel('Search backend', { exact: true }).selectOption('exa');

  const creds = await mainWindow.evaluate(() =>
    (
      window as unknown as {
        stem: { getSettings(): Promise<{ webSearch: { credentials: Record<string, string> } }> };
      }
    ).stem
      .getSettings()
      .then((s) => s.webSearch.credentials)
  );
  expect(creds.exaApiKey).toBe('exa-key-1');
  expect(creds.braveApiKey).toBe('brave-key-1');
});

test('the web-search toggle shows regardless of the selected model', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Settings', exact: true }).click();

  // Previously gated on selectedModel.supportsNativeWebSearch, which was false for
  // every provider but openai-codex.
  await expect(mainWindow.getByRole('checkbox', { name: 'Web search' }).first()).toBeVisible();
});
