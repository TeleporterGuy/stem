// The Web search section's catalogue: which backends the picker offers, what
// each one needs before it will answer, and how that reads in the UI.
//
// Split out of SettingsTab so the readiness rules — the part that is easy to get
// subtly wrong, and the part a user acts on — are unit-testable without mounting
// the whole settings screen.

/**
 * What a backend needs before it will answer a search:
 * - `none` — nothing at all to configure (the meta-backends).
 * - `keyless` — searches with no credential; a key only upgrades the path.
 * - `keyless-capped` — searches with no credential, but only so many times. Exa's
 *   public MCP endpoint is a demo allowance, not a tier: spend it and every call
 *   returns HTTP 429 with `retry-after` set to the seconds remaining until the
 *   next UTC midnight. Measured at 12.9 hours locked out, and `auto` then falls
 *   through to a backend that costs an inference — or, with no ChatGPT sign-in
 *   and no other key, throws "Auto provider search failed" and web search is
 *   simply gone for the day. Reads as ready, because it is, but not as free.
 * - `signin` — no key needed *if* the matching account is connected under AI
 *   Providers; otherwise a key. This is the ChatGPT case: pi-web-access resolves
 *   OpenAI auth through pi's model registry first (openai-codex, then openai), so
 *   a ChatGPT subscription pays for its own searches and `openaiApiKey` stays empty.
 *   Grok works the same way through the `xai` provider.
 * - `required` — dead until its credential is filled in.
 */
export type KeyNeed = 'none' | 'keyless' | 'keyless-capped' | 'signin' | 'required';

export interface SearchBackend {
  id: string;
  label: string;
  /** Config key pi-web-access reads for this backend, or null if it takes none. */
  field: string | null;
  need: KeyNeed;
  /** Provider ids (as runtimeStatus reports them) whose auth unlocks it keyless. */
  signedInBy?: string[];
  /**
   * How that sign-in reads in the status line ("uses your ChatGPT sign-in").
   * Named per backend rather than derived from `label`, which carries the vendor
   * ("ChatGPT / OpenAI") where the status wants the account.
   */
  signInName?: string;
  placeholder?: string;
  note?: string;
}

/**
 * Search backends pi-web-access can use, in the order the picker lists them. `field`
 * is the exact config key that backend's loader reads (they are NOT uniformly
 * `<name>ApiKey` — SearXNG wants a base URL), mirroring SEARCH_BACKENDS in
 * main/pi/web-search.ts. `field: null` means the backend needs no credential.
 *
 * The backend is independent of the model being chatted with: an Ollama chat can
 * search through Exa, a ChatGPT chat through SearXNG.
 */
export const SEARCH_BACKENDS: SearchBackend[] = [
  {
    id: 'auto',
    label: 'Automatic',
    field: null,
    need: 'none',
    note:
      'Tries each backend that queries an index before any that costs a model inference, ' +
      'ending at Exa’s keyless route — so with nothing configured, it ends on a capped allowance.'
  },
  {
    id: 'all',
    label: 'All at once',
    field: null,
    need: 'none',
    note: 'Queries every configured backend and combines the answers.'
  },
  {
    id: 'openai',
    label: 'ChatGPT / OpenAI',
    field: 'openaiApiKey',
    need: 'signin',
    signedInBy: ['openai-codex', 'openai'],
    signInName: 'ChatGPT',
    placeholder: 'sk-…',
    note: 'Searches bill to the ChatGPT account you connect under AI Providers above.'
  },
  {
    id: 'xai',
    label: 'Grok / xAI',
    field: 'xaiApiKey',
    need: 'signin',
    signedInBy: ['xai'],
    signInName: 'Grok',
    placeholder: 'xai-…',
    // Worth stating plainly: this is the one backend that spends something the
    // user also needs for chatting. A single question fans out to roughly a
    // dozen searches inside Grok's own inference.
    note: 'Grok searches the web itself. No key needed, but each search draws on the same allowance as your Grok chats.'
  },
  {
    id: 'exa',
    label: 'Exa',
    field: 'exaApiKey',
    need: 'keyless-capped',
    placeholder: 'exa-…',
    note:
      'Without a key it runs on Exa MCP’s shared free allowance, which resets at midnight UTC — ' +
      'run it out and searches stop until then. A key switches it to the direct API, and Exa’s ' +
      'own free tier (dashboard.exa.ai/api-keys) covers thousands of searches a month.'
  },
  { id: 'brave', label: 'Brave', field: 'braveApiKey', need: 'required', placeholder: 'BSA…' },
  { id: 'tavily', label: 'Tavily', field: 'tavilyApiKey', need: 'required', placeholder: 'tvly-…' },
  { id: 'perplexity', label: 'Perplexity', field: 'perplexityApiKey', need: 'required', placeholder: 'pplx-…' },
  // Gemini can also run keyless off Chrome cookies, but only with
  // `allowBrowserCookies` in web-search.json — which Stem never writes.
  { id: 'gemini', label: 'Gemini', field: 'geminiApiKey', need: 'required', placeholder: 'AIza…' },
  { id: 'parallel', label: 'Parallel', field: 'parallelApiKey', need: 'required' },
  { id: 'tinyfish', label: 'TinyFish', field: 'tinyfishApiKey', need: 'required', placeholder: 'sk-tinyfish-…' },
  { id: 'serpdive', label: 'SERPdive', field: 'serpdiveApiKey', need: 'required' },
  { id: 'anysearch', label: 'AnySearch', field: 'anysearchApiKey', need: 'required' },
  {
    id: 'searxng',
    label: 'SearXNG (self-hosted)',
    field: 'searxngBaseUrl',
    need: 'required',
    placeholder: 'https://search.example.com',
    note: 'Your own instance, so no key or account — but nothing works until you name it here.'
  }
];

/** "key" / "endpoint" — SearXNG is the one backend whose credential is a URL. */
export function credentialNoun(b: Pick<SearchBackend, 'field'>): string {
  return b.field?.endsWith('ApiKey') ? 'key' : 'endpoint';
}

/** Field label for a backend's credential: "Exa key" / "SearXNG endpoint". */
export function credentialLabel(b: Pick<SearchBackend, 'label' | 'field'>): string {
  return `${b.label.replace(/ \(self-hosted\)$/, '')} ${credentialNoun(b)}`;
}

/**
 * Which section of the picker a backend sits in. The grouping *is* the answer to
 * "what can I use without setting anything up" — so the rows themselves stay bare
 * names, and the one selected row explains itself below the picker.
 */
export type BackendGroup = 'keyless' | 'configured' | 'unset';

export interface BackendState {
  /** Would a search through this backend work right now? */
  ready: boolean;
  /** Which picker section it belongs to. */
  group: BackendGroup;
  /** Short reason, spelled out under the picker for the selected backend. */
  status: string;
  /**
   * Ready, but on borrowed time — a free allowance that will run out and take
   * search with it. Distinct from `!ready`: nothing is broken yet, so this must
   * not read as an error, only as something to deal with before it bites.
   */
  capped?: boolean;
}

/** Whether the user has configured no search credential at all. */
function everyCredentialEmpty(credentials: Record<string, string>): boolean {
  return SEARCH_BACKENDS.every((b) => !b.field || !credentials[b.field]?.trim());
}

/**
 * Whether a backend would work as things stand, and why — so you can see which
 * ones ask nothing of you *before* selecting one and finding out.
 *
 * A saved credential always wins, because that is the path the backend takes.
 * Otherwise the keyless routes decide it: Exa's public MCP endpoint, or, for
 * ChatGPT, an already-connected sign-in.
 */
export function backendState(
  b: SearchBackend,
  credentials: Record<string, string>,
  providers: string[]
): BackendState {
  if (b.need === 'none') {
    // The meta-backends inherit the cap when there is nothing else to reach: with
    // no key anywhere, `auto` walks the chain and lands on Exa's free allowance,
    // and `all` fans out across the same nothing. Worth saying here rather than
    // only under Exa — `auto` is the default, so it is what most people are on.
    return everyCredentialEmpty(credentials)
      ? {
          ready: true,
          group: 'keyless',
          capped: true,
          status: 'nothing to set up — but with no key anywhere this ends on Exa’s capped free allowance'
        }
      : { ready: true, group: 'keyless', status: 'nothing to set up' };
  }
  if (b.field && credentials[b.field]?.trim()) {
    return { ready: true, group: 'configured', status: `${credentialNoun(b)} saved` };
  }
  if (b.need === 'keyless') return { ready: true, group: 'keyless', status: 'no key needed' };
  if (b.need === 'keyless-capped') {
    return {
      ready: true,
      group: 'keyless',
      capped: true,
      status: 'works without a key, but only so many searches a day — add a key to lift the cap'
    };
  }
  if (b.need === 'signin') {
    // A sign-in is not a key, so this belongs with the keyless backends — the
    // whole point being that it costs you nothing extra to pick it.
    const account = b.signInName ?? b.label;
    return (b.signedInBy ?? []).some((p) => providers.includes(p))
      ? { ready: true, group: 'keyless', status: `no key needed — uses your ${account} sign-in` }
      : { ready: false, group: 'unset', status: `needs a ${account} sign-in or a key` };
  }
  return {
    ready: false,
    group: 'unset',
    status: credentialNoun(b) === 'key' ? 'needs a key' : 'needs an endpoint'
  };
}

/**
 * How a backend reads as a row in the picker.
 *
 * Rows are otherwise bare names on purpose — the section heading carries "what
 * does this still want from me", and the selected row explains itself underneath.
 * A capped allowance breaks that rule because it is the one case the heading gets
 * wrong: "Works with no key" is true of Exa and also, by omission, a promise it
 * cannot keep past the daily limit. Cheaper to say it in the row than to let
 * someone find out when search stops answering.
 */
export function backendOptionLabel(
  b: SearchBackend,
  credentials: Record<string, string>,
  providers: string[]
): string {
  return backendState(b, credentials, providers).capped ? `${b.label} — free limit, no key` : b.label;
}

/** Section headings, in the order the picker stacks them. */
export const BACKEND_GROUP_LABELS: { group: BackendGroup; label: string }[] = [
  { group: 'keyless', label: 'Works with no key' },
  { group: 'configured', label: 'Configured' },
  { group: 'unset', label: 'Not set up yet' }
];

/**
 * The picker's sections, in order, each keeping the canonical backend order.
 * Empty sections are dropped — a lone "Configured" heading over nothing reads as
 * a bug, and on a fresh install two of the three are empty.
 */
export function backendSections(
  credentials: Record<string, string>,
  providers: string[]
): { label: string; backends: SearchBackend[] }[] {
  return BACKEND_GROUP_LABELS.map(({ group, label }) => ({
    label,
    backends: SEARCH_BACKENDS.filter((b) => backendState(b, credentials, providers).group === group)
  })).filter((s) => s.backends.length > 0);
}

/**
 * How the always-visible key list annotates a field: whether you can leave it
 * blank, and — for a backend whose keyless route is not open yet — that leaving
 * it blank currently gets you nothing.
 */
export function credentialRequirement(
  b: SearchBackend,
  credentials: Record<string, string>,
  providers: string[]
): string {
  if (b.need === 'required') return '(required)';
  const state = backendState(b, credentials, providers);
  if (state.capped) return '(optional — but the keyless route is capped daily)';
  return state.ready ? '(optional)' : '(optional — but nothing else unlocks it yet)';
}

/** Endpoints that tune a backend rather than selecting one. */
export const SEARCH_ENDPOINTS: { field: string; label: string; placeholder: string; hint: string }[] = [
  {
    field: 'openaiResponsesUrl',
    label: 'OpenAI Responses endpoint',
    placeholder: 'https://api.openai.com/v1/responses',
    hint: 'Point the OpenAI backend at a compatible gateway instead.'
  },
  {
    field: 'firecrawlBaseUrl',
    label: 'Firecrawl endpoint',
    placeholder: 'https://firecrawl.example.com',
    hint: 'Self-hosted Firecrawl, tried first when a page blocks plain fetching.'
  },
  { field: 'firecrawlApiKey', label: 'Firecrawl key', placeholder: 'fc-…', hint: 'Only if your Firecrawl requires one.' }
];
