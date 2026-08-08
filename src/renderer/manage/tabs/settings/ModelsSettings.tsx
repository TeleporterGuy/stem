import { useCallback, useEffect, useRef, useState } from 'react';
import { Plug, Globe, HardDrive, Plus, Minus, X, Check, RefreshCw } from 'lucide-react';
import type {
  AuthProviderId,
  ApiKeyProviderId,
  WebSearchSettings,
  LocalProviderApi,
  LocalProviderId,
  LocalProvidersSettings,
  LocalProviderTestResult
} from '../../../../shared/types';
import { API_KEY_PROVIDER_IDS, AUTH_PROVIDER_IDS, isLocalProviderId, providerName } from '../../../../shared/providers';
import { appDefaultModel, resolveJudgeModel } from '../../../../shared/modelRoles';
import { localProbeTarget, probeStillDescribes } from '../../../localProbe';
import { RequestGate } from '../../../requestGate';
import { InfoTip } from '../../../ui/InfoTip';
import { ModelPicker } from '../../../ui/ModelPicker';
import type { ModelTabProps } from '../shared';
import {
  backendOptionLabel,
  backendSections,
  backendState,
  credentialInputType,
  credentialLabel,
  credentialRequirement,
  SEARCH_BACKENDS,
  SEARCH_ENDPOINTS
} from '../../searchBackends';

/**
 * Settings → Models: which model does which job, who Stem is signed in to, and
 * who answers a search.
 *
 * Three lists that look unrelated and aren't. Model roles is the top of the
 * chain — what each job runs on. The AI providers are who Stem is allowed to ask
 * at all, which is what makes a role assignable. And the search backend is who
 * it asks when the answer isn't in a model; that one shares credentials with the
 * providers above, so a ChatGPT sign-in made here is also a search backend
 * below, and the picker says so.
 */
export function ModelsSettings({ models, modelId, onSelectModel, deadProvider }: ModelsSettingsProps) {
  // Connected AI providers, so the search picker can tell you which backends
  // already work on a sign-in you have. Kept in step with the Providers section,
  // which broadcasts on every connect/disconnect.
  const [providers, setProviders] = useState<string[]>([]);

  useEffect(() => {
    const load = (): void => {
      void window.stem.runtimeStatus().then((s) => setProviders(s.providers ?? []));
    };
    load();
    window.addEventListener('stem:providers-changed', load);
    return () => window.removeEventListener('stem:providers-changed', load);
  }, []);

  return (
    <div>
      <ModelRolesSection models={models} modelId={modelId} onSelectModel={onSelectModel} />
      <ProvidersSection deadProvider={deadProvider} />
      <WebSearchSection providers={providers} />
    </div>
  );
}

type ModelsSettingsProps = ModelTabProps & { deadProvider?: string | null };

/**
 * Every job Stem runs a model for, in one list.
 *
 * Each of these is also editable where it belongs — the memory model under
 * Memory, the curator under Tools, subjects and the safety check under Chat —
 * and stays there. This is the other view: the one you open when the question is
 * "what is running on what", which no single feature panel can answer. Both
 * views write the same setting, and only one manage tab is mounted at a time, so
 * they cannot disagree.
 *
 * Connected folders can each override the memory model, but there can be any
 * number of them and they belong to the folder, not to the app — so they are
 * counted here and edited there.
 */
function ModelRolesSection({ models, modelId, onSelectModel }: ModelTabProps) {
  const [quickChatModel, setQuickChatModel] = useState<string | null>(null);
  const [subjectModel, setSubjectModel] = useState<string | null>(null);
  const [judgeModel, setJudgeModel] = useState<string | null>(null);
  const [memoryModel, setMemoryModel] = useState<string | null>(null);
  const [curatorModel, setCuratorModel] = useState<string | null>(null);
  const [folderOverrides, setFolderOverrides] = useState(0);

  useEffect(() => {
    void window.stem.getSettings().then((s) => {
      setQuickChatModel(s.quickChat.defaultModel);
      setSubjectModel(s.chats.subjectModel);
      setJudgeModel(s.exec.judgeModel);
      setMemoryModel(s.memory.model);
      setCuratorModel(s.skills.model);
    });
    void window.stem
      .listConnectedFolders()
      .then((folders) => setFolderOverrides(folders.filter((f) => f.learnModel).length))
      .catch(() => undefined);
  }, []);

  const appDefault = appDefaultModel(models);

  return (
    <>
      <div className="grp-head grp-head-row">
        Model roles
        <InfoTip label="About model roles">
          Stem runs more than one model. The one you chat with writes the replies; the rest work in
          the background, which is why they default to something cheaper and why they are worth
          knowing about. Every role here is also editable where it belongs — this is the same
          setting seen from one place instead of four. <strong>Default</strong> and{' '}
          <strong>Auto</strong> name a rule rather than a model, so each picker says underneath what
          the rule resolves to today.
        </InfoTip>
      </div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Chatting with you <em className="set-opt">also in Chat</em>
          </span>
          <ModelPicker
            models={models}
            value={modelId}
            onChange={(id) => onSelectModel(id ?? '')}
            ariaLabel="Model"
          />
        </div>

        <div className="set-block">
          <span className="set-sub">
            Quick Chat <em className="set-opt">also in App</em>
          </span>
          <ModelPicker
            models={models}
            value={quickChatModel}
            onChange={(id) => {
              setQuickChatModel(id); // optimistic; reconcile from the saved settings
              window.stem.updateQuickChat({ defaultModel: id }).then((s) => setQuickChatModel(s.quickChat.defaultModel));
            }}
            emptyLabel="Same as main"
            ariaLabel="Quick Chat default model"
            resolvedDefault={appDefault}
          />
        </div>

        <div className="set-block">
          <span className="set-sub">
            Chat subjects <em className="set-opt">also in Chat</em>
          </span>
          <ModelPicker
            models={models}
            value={subjectModel}
            onChange={(id) => {
              setSubjectModel(id);
              window.stem.updateChatsSettings({ subjectModel: id }).then((s) => {
                setSubjectModel(s.chats.subjectModel);
                window.dispatchEvent(new CustomEvent('stem:chat-settings'));
              });
            }}
            emptyLabel="Default (recommended)"
            ariaLabel="Subject model"
            resolvedDefault={appDefault}
          />
        </div>

        <div className="set-block">
          <span className="set-sub">
            Command safety check <em className="set-opt">also in Chat</em>
          </span>
          <ModelPicker
            models={models}
            value={judgeModel}
            onChange={(id) => {
              setJudgeModel(id);
              window.stem.updateExecSettings({ judgeModel: id }).then((s) => setJudgeModel(s.exec.judgeModel));
            }}
            emptyLabel="Auto"
            ariaLabel="Safety-check model"
            resolvedDefault={resolveJudgeModel({ judgeModel: null }, models, modelId)}
          />
        </div>

        <div className="set-block">
          <span className="set-sub">
            Memory <em className="set-opt">also in Memory</em>
          </span>
          <ModelPicker
            models={models}
            value={memoryModel}
            onChange={(id) => {
              setMemoryModel(id);
              window.stem.updateMemorySettings({ model: id }).then((s) => setMemoryModel(s.memory.model));
            }}
            emptyLabel="Default (recommended)"
            ariaLabel="Memory model"
            resolvedDefault={appDefault}
          />
          {folderOverrides > 0 && (
            <em className="mp-resolved">
              {folderOverrides} connected folder{folderOverrides === 1 ? '' : 's'} override
              {folderOverrides === 1 ? 's' : ''} this — Sources › Connected folders
            </em>
          )}
        </div>

        <div className="set-block">
          <span className="set-sub">
            Skills curator <em className="set-opt">also in Tools</em>
          </span>
          <ModelPicker
            models={models}
            value={curatorModel}
            onChange={(id) => {
              setCuratorModel(id);
              window.stem.updateSkillsSettings({ model: id }).then((s) => setCuratorModel(s.skills.model));
            }}
            emptyLabel="Default (recommended)"
            ariaLabel="Skills curator model"
            resolvedDefault={appDefault}
          />
        </div>
      </div>
    </>
  );
}

/**
 * Which service answers a web search, and the keys for the ones that need them.
 * Independent of the chat model on purpose — see the ⓘ.
 */
function WebSearchSection({ providers }: { providers: string[] }) {
  const [ws, setWs] = useState<WebSearchSettings>({
    main: true,
    quickChat: true,
    provider: 'auto',
    credentials: {}
  });
  // The all-backends key list is collapsed by default: most people configure one
  // backend, and a wall of empty key fields would bury the picker.
  const [showSearchKeys, setShowSearchKeys] = useState(false);

  useEffect(() => {
    void window.stem.getSettings().then((s) => setWs(s.webSearch));
  }, []);

  function updateWebSearch(patch: Partial<WebSearchSettings>) {
    setWs((cur) => ({ ...cur, ...patch })); // optimistic; reconcile below
    window.stem.updateWebSearch(patch).then((s) => setWs(s.webSearch));
  }

  /**
   * Patch one credential. Sent as the whole map because the IPC merges settings
   * shallowly — a partial `credentials` would drop every other backend's key.
   */
  function setCredential(field: string, value: string) {
    updateWebSearch({ credentials: { ...ws.credentials, [field]: value } });
  }

  const activeBackend = SEARCH_BACKENDS.find((b) => b.id === ws.provider) ?? null;
  const activeState = activeBackend ? backendState(activeBackend, ws.credentials, providers) : null;

  return (
    <>
      <div className="grp-head">Web search</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Search backend{' '}
            <InfoTip label="About search backends">
              This is independent of the model you chat with — a local Ollama chat can search
              through Exa, a ChatGPT chat through SearXNG. <strong>Automatic</strong> tries each
              backend you have configured and ends at one that needs no key, so search works with
              no setup at all. <strong>All at once</strong> queries every configured backend and
              combines the answers. Keys below are kept for every backend, so switching between
              them never means re-entering one.
              <br />
              Automatic orders that chain by cost, not by what you have signed into: every backend
              that looks something up in an index comes first, then Exa’s keyless route, and only
              then the ones that spend a whole model inference to run the query for you. So a
              ChatGPT subscription does <em>not</em> mean your searches go through ChatGPT — it
              is the fallback for when everything above it is missing or failing. Pick{' '}
              <strong>ChatGPT / OpenAI</strong> by name if you want it every time.
              <br />
              The list is grouped by what each backend still wants from you.{' '}
              <strong>Works with no key</strong> holds the ones you can pick right now — ChatGPT
              rides the sign-in you already have under AI Providers, billing searches to that
              subscription, and Exa searches through its public endpoint. That public endpoint is
              a shared free allowance that resets at midnight UTC, so rows marked{' '}
              <em>free limit, no key</em> work today but will stop once you run it out. A key
              from dashboard.exa.ai is the fix, and Exa’s own free tier is far larger.
              <br />
              A few backends — Grok, AnySearch, Bright Data, SerpBase — are never reached by
              Automatic or All at once, whatever you configure. They answer only when selected by
              name.
            </InfoTip>
          </span>
          <select
            className="ifield"
            aria-label="Search backend"
            value={ws.provider}
            onChange={(e) => updateWebSearch({ provider: e.target.value })}
          >
            {/* Grouped by what each backend still wants from you, so the rows
                stay bare names and the heading carries the answer. */}
            {backendSections(ws.credentials, providers).map((section) => (
              <optgroup key={section.label} label={section.label}>
                {section.backends.map((b) => (
                  <option key={b.id} value={b.id}>
                    {backendOptionLabel(b, ws.credentials, providers)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {/* The selected backend's own field, inline — the common case is
              "pick one, paste its key" without opening anything else. */}
          {activeBackend?.field && (
            <input
              className="ifield"
              type={credentialInputType(activeBackend.field)}
              placeholder={
                activeBackend.placeholder
                  ? `${activeBackend.placeholder}${activeState?.ready ? ' (optional)' : ''}`
                  : activeState?.ready
                    ? 'Optional'
                    : undefined
              }
              aria-label={credentialLabel(activeBackend)}
              value={ws.credentials[activeBackend.field] ?? ''}
              onChange={(e) => setCredential(activeBackend.field as string, e.target.value)}
            />
          )}
          {/* Bright Data's second half. Inline beside the key rather than hidden in
              the full key list, because a key on its own leaves the backend dead
              and the status line right below already says so. */}
          {activeBackend?.also && (
            <input
              className="ifield"
              type={credentialInputType(activeBackend.also.field)}
              placeholder={activeBackend.also.placeholder}
              aria-label={activeBackend.also.label}
              value={ws.credentials[activeBackend.also.field] ?? ''}
              onChange={(e) => setCredential(activeBackend.also!.field, e.target.value)}
            />
          )}
          {activeBackend && activeState && (
            // Three states, not two: broken, fine, and fine-until-it-isn't. The
            // last one has to be visible without reading as an error.
            //
            // The line itself stays a glanceable verdict. Everything that explains
            // it — why this backend is in that state, and how the chain treats it —
            // goes behind the (i), because the version that ran the whole
            // explanation inline was long enough that nobody read either half.
            <em className={activeState.ready && !activeState.capped ? 'muted' : 'muted set-warn'}>
              {!activeState.ready ? '!' : activeState.capped ? '⚠' : '✓'} {activeState.status}
              {(activeState.detail || activeBackend.note) && (
                <>
                  {' '}
                  <InfoTip label={`About ${activeBackend.label}`}>
                    {activeState.detail}
                    {activeState.detail && activeBackend.note && <br />}
                    {activeBackend.note}
                  </InfoTip>
                </>
              )}
            </em>
          )}
        </div>

        <div className="set-block">
          <button className="push" onClick={() => setShowSearchKeys((v) => !v)} aria-expanded={showSearchKeys}>
            {showSearchKeys ? 'Hide' : 'Show'} all backend keys
          </button>
          {showSearchKeys && (
            <>
              {SEARCH_BACKENDS.filter((b) => b.field).map((b) => (
                <label className="set-block" key={b.field}>
                  <span className="set-sub">
                    {credentialLabel(b)}{' '}
                    {/* Which of these you can leave blank, without selecting each
                        backend in turn to read its status line. */}
                    <em className="set-opt">{credentialRequirement(b, ws.credentials, providers)}</em>
                  </span>
                  <input
                    className="ifield"
                    type={credentialInputType(b.field as string)}
                    placeholder={b.placeholder}
                    aria-label={credentialLabel(b)}
                    value={ws.credentials[b.field as string] ?? ''}
                    onChange={(e) => setCredential(b.field as string, e.target.value)}
                  />
                  {b.also && (
                    <>
                      <span className="set-sub">
                        {b.also.label} <em className="set-opt">(required)</em>
                      </span>
                      <input
                        className="ifield"
                        type={credentialInputType(b.also.field)}
                        placeholder={b.also.placeholder}
                        aria-label={b.also.label}
                        value={ws.credentials[b.also.field] ?? ''}
                        onChange={(e) => setCredential(b.also!.field, e.target.value)}
                      />
                      {b.also.hint && <em className="muted">{b.also.hint}</em>}
                    </>
                  )}
                </label>
              ))}
              {SEARCH_ENDPOINTS.map((f) => (
                <label className="set-block" key={f.field}>
                  <span className="set-sub">{f.label}</span>
                  <input
                    className="ifield"
                    type={f.field.endsWith('ApiKey') ? 'password' : 'url'}
                    placeholder={f.placeholder}
                    aria-label={f.label}
                    value={ws.credentials[f.field] ?? ''}
                    onChange={(e) => setCredential(f.field, e.target.value)}
                  />
                  <em className="muted">{f.hint}</em>
                </label>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}


const OAUTH_CHOICES: { id: AuthProviderId; hint: string }[] = [
  { id: 'openai-codex', hint: 'Sign in with a ChatGPT Plus or Pro subscription.' },
  { id: 'anthropic', hint: 'Sign in with a Claude Pro or Max subscription.' },
  { id: 'xai', hint: 'Sign in with a SuperGrok or X Premium subscription.' }
];

/** How a connected provider signed in — shown as the row's secondary line. */
function providerKind(id: string): string {
  if (id === 'openai-codex') return 'ChatGPT subscription';
  if (isLocalProviderId(id)) return 'Server';
  return 'API key / subscription';
}

/**
 * Provider management, mirroring the MCP Servers tab: connected providers as a
 * grouped list with a +/− gutter; the + button opens an Add Provider form with
 * an account / API key / local-server segmented choice. Runs against the same
 * auth IPC as the onboarding wizard.
 */
function ProvidersSection({ deadProvider }: { deadProvider?: string | null }) {
  const [providers, setProviders] = useState<string[]>([]);
  const [local, setLocal] = useState<LocalProvidersSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The Add Provider form is collapsed behind the + button (like the MCP tab's
  // Add Server) so the steady state is a calm list of connected providers.
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'account' | 'apikey' | 'local'>('account');
  // In-flight OAuth attempt (null = none). Mirrors the onboarding wizard's
  // oauthWait/manualInput steps in miniature; completion resolves the
  // providerLogin promise, so `done` events only clear transient state.
  const [oauth, setOauth] = useState<{
    provider: AuthProviderId;
    authUrl: string | null;
    // Device-code flows (Grok) never send an auth-url: the browser opens on a
    // page that asks for this code, so dropping it would leave the user staring
    // at "Waiting for your browser…" with nothing to type.
    deviceCode: { userCode: string; verificationUri: string } | null;
    progress: string | null;
    input: { requestId: string; message: string; placeholder?: string } | null;
  } | null>(null);

  const refresh = useCallback(async () => {
    const [status, settings] = await Promise.all([window.stem.runtimeStatus(), window.stem.getSettings()]);
    setProviders(status.providers ?? []);
    setLocal(settings.localProviders);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      window.stem.onAuthEvent((e) => {
        setOauth((cur) => {
          if (!cur) return cur;
          switch (e.kind) {
            case 'auth-url':
              return { ...cur, authUrl: e.url };
            case 'device-code':
              return { ...cur, deviceCode: { userCode: e.userCode, verificationUri: e.verificationUri } };
            case 'progress':
              return { ...cur, progress: e.message };
            case 'input-request':
              return { ...cur, input: { requestId: e.requestId, message: e.message, placeholder: e.placeholder } };
            default:
              return cur;
          }
        });
      }),
    []
  );

  /** Providers changed: refresh this section AND tell App to reload status+models. */
  const changed = useCallback(async () => {
    await refresh();
    window.dispatchEvent(new CustomEvent('stem:providers-changed'));
  }, [refresh]);

  function closeForm() {
    setAdding(false);
    setMode('account');
  }

  async function startOAuth(provider: AuthProviderId) {
    setError(null);
    setOauth({ provider, authUrl: null, deviceCode: null, progress: null, input: null });
    try {
      const res = await window.stem.providerLogin(provider);
      if (!res.ok) setError(res.error ?? 'Sign-in failed.');
      else {
        await changed();
        closeForm();
      }
    } finally {
      setOauth(null);
    }
  }

  function cancelOAuth() {
    void window.stem.providerLoginCancel();
    setOauth(null);
  }

  async function disconnect(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await window.stem.disconnectProvider(id);
      if (!res.ok) setError(res.error ?? 'Could not disconnect.');
      else {
        setSelected(null);
        await changed();
      }
    } finally {
      setBusy(false);
    }
  }

  // Cloud rows come from auth.json keys; local rows from enabled servers.
  const cloudProviders = providers.filter((p) => !isLocalProviderId(p));
  const enabledLocals = local ? (Object.keys(local) as LocalProviderId[]).filter((id) => local[id].enabled) : [];
  const rows = [
    ...cloudProviders.map((id) => ({ id, local: false, detail: providerKind(id) })),
    // A custom endpoint is registered the same way but needn't be on this box, so
    // it keeps the remote icon.
    ...enabledLocals.map((id) => ({ id, local: id !== 'custom', detail: local![id].baseUrl }))
  ];

  return (
    <>
      <div className="grp-head">AI Providers</div>
      {rows.length === 0 ? (
        <div className="group">
          <div className="group-row">
            <span className="row-main">
              <em>No providers yet. Add one with the + button.</em>
            </span>
          </div>
        </div>
      ) : (
        <div className="group">
          {rows.map((row) => (
            <div
              key={row.id}
              className={`group-row${selected === row.id ? ' selected' : ''}`}
              onClick={() => setSelected(row.id)}
            >
              <span className={`row-icon ${row.local ? 'local' : 'remote'}`}>
                {row.local ? <HardDrive size={14} /> : <Globe size={14} />}
              </span>
              <span className="row-main">
                <strong>{providerName(row.id)}</strong>
                <em>{row.detail}</em>
              </span>
              {row.id === deadProvider && (
                <button
                  className="pill danger row-reconnect"
                  title="Session expired — reconnect"
                  onClick={(e) => {
                    e.stopPropagation();
                    if ((AUTH_PROVIDER_IDS as string[]).includes(row.id)) void startOAuth(row.id as AuthProviderId);
                  }}
                >
                  Session expired · Reconnect
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="gutter">
        <button title="Add provider" onClick={() => setAdding(true)}>
          <Plus size={15} />
        </button>
        <button
          title="Reconnect selected"
          onClick={() => {
            if (selected && (AUTH_PROVIDER_IDS as string[]).includes(selected)) {
              void startOAuth(selected as AuthProviderId);
            }
          }}
          disabled={!selected || busy || !(AUTH_PROVIDER_IDS as string[]).includes(selected ?? '')}
        >
          <RefreshCw size={15} />
        </button>
        <button
          title="Disconnect selected"
          onClick={() => selected && void disconnect(selected)}
          disabled={!selected || busy}
        >
          <Minus size={15} />
        </button>
      </div>

      {adding && (
        <>
          <div className="grp-head">Add Provider</div>
          <div className="formgroup">
            {!oauth && (
              <>
                <div className="seg-ctl">
                  <button className={mode === 'account' ? 'active' : ''} onClick={() => setMode('account')}>
                    Account
                  </button>
                  <button className={mode === 'apikey' ? 'active' : ''} onClick={() => setMode('apikey')}>
                    API key
                  </button>
                  {/* "Server", not "Local server": the same form now also takes a
                      custom endpoint, which needn't be on this machine. */}
                  <button className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>
                    Server
                  </button>
                </div>
                {mode === 'account' && (
                  <ProviderAccountForm onConnect={(id) => void startOAuth(id)} onCancel={closeForm} />
                )}
                {mode === 'apikey' && (
                  <ProviderApiKeyForm
                    onSaved={async () => {
                      await changed();
                      closeForm();
                    }}
                    onError={setError}
                    onCancel={closeForm}
                  />
                )}
                {mode === 'local' && local && (
                  <LocalServerAddForm
                    settings={local}
                    onSaved={async () => {
                      await changed();
                      closeForm();
                    }}
                    onError={setError}
                    onCancel={closeForm}
                  />
                )}
              </>
            )}

            {oauth && !oauth.input && (
              <div className="set-block">
                <span className="set-sub">Waiting for your browser…</span>
                <p className="muted">
                  Finish signing in to {providerName(oauth.provider)} in your browser — Stem continues automatically.
                </p>
                {oauth.deviceCode && (
                  <p className="muted">
                    Enter code <code className="gate-code">{oauth.deviceCode.userCode}</code> at{' '}
                    {oauth.deviceCode.verificationUri}
                  </p>
                )}
                {oauth.authUrl && (
                  <p className="muted">
                    Nothing happened? Open this link yourself: <code className="login-cmd">{oauth.authUrl}</code>
                  </p>
                )}
                {oauth.progress && <p className="muted">{oauth.progress}</p>}
                <div className="push-row">
                  <button className="push" onClick={cancelOAuth}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {oauth?.input && (
              <ProviderManualCode
                message={oauth.input.message}
                placeholder={oauth.input.placeholder}
                onSubmit={(value) => {
                  void window.stem.providerLoginRespond(oauth.input!.requestId, value);
                  setOauth({ ...oauth, input: null });
                }}
                onCancel={cancelOAuth}
              />
            )}
          </div>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </>
  );
}

/** Subscription sign-in (ChatGPT / Claude): pick the account, then Connect. */
function ProviderAccountForm({
  onConnect,
  onCancel
}: {
  onConnect: (id: AuthProviderId) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<AuthProviderId>('openai-codex');
  const choice = OAUTH_CHOICES.find((c) => c.id === provider)!;
  return (
    <div className="set-block">
      <select
        className="ifield"
        aria-label="Account provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as AuthProviderId)}
      >
        {OAUTH_CHOICES.map((c) => (
          <option key={c.id} value={c.id}>
            {providerName(c.id)}
          </option>
        ))}
      </select>
      <p className="muted">{choice.hint}</p>
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="push default" onClick={() => onConnect(provider)}>
          Connect
        </button>
      </div>
    </div>
  );
}

function ProviderManualCode({
  message,
  placeholder,
  onSubmit,
  onCancel
}: {
  message: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <form
      className="set-block"
      onSubmit={(e) => {
        e.preventDefault();
        const value = inputRef.current?.value.trim();
        if (value) onSubmit(value);
      }}
    >
      <span className="set-sub">{message}</span>
      <input ref={inputRef} className="ifield" type="text" placeholder={placeholder ?? 'Paste the code here'} autoFocus />
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="push default">
          Continue
        </button>
      </div>
    </form>
  );
}

function ProviderApiKeyForm({
  onSaved,
  onError,
  onCancel
}: {
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<ApiKeyProviderId>('anthropic');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="set-block"
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = key.trim();
        if (!trimmed) return;
        setSaving(true);
        onError(null);
        try {
          const res = await window.stem.setApiKey(provider, trimmed);
          if (!res.ok) onError(res.error ?? 'The API key could not be saved.');
          else {
            setKey('');
            await onSaved();
          }
        } finally {
          setSaving(false);
        }
      }}
    >
      <select
        className="ifield"
        aria-label="API key provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as ApiKeyProviderId)}
      >
        {API_KEY_PROVIDER_IDS.map((id) => (
          <option key={id} value={id}>
            {providerName(id)}
          </option>
        ))}
      </select>
      <input
        className="ifield"
        type="password"
        placeholder="sk-…"
        aria-label="API key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoFocus
      />
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="push default" disabled={saving || !key.trim()}>
          {saving ? 'Saving…' : 'Save key'}
        </button>
      </div>
    </form>
  );
}

/**
 * Add an OpenAI-compatible server (Ollama / LM Studio / a custom endpoint): pick
 * the server, adjust the URL if needed, optionally Test, then Enable. Editing
 * later = disconnect (−) and re-add, matching the MCP servers list.
 *
 * The custom endpoint adds a key field and swaps model discovery for a typed
 * list: an arbitrary endpoint may not serve GET /v1/models at all (or may serve
 * far more than the key can reach), so Test becomes a convenience that fills the
 * field in rather than the thing that decides the catalog.
 *
 * The how-it-works prose for all three lives in the header InfoTip, not inline —
 * the fields differ by selection and a paragraph per branch buries the form.
 */
function LocalServerAddForm({
  settings,
  onSaved,
  onError,
  onCancel
}: {
  settings: LocalProvidersSettings;
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
  onCancel: () => void;
}) {
  const [server, setServer] = useState<LocalProviderId>('ollama');
  const [baseUrl, setBaseUrl] = useState(settings.ollama.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  // API flavor for the Custom endpoint. Ollama/LM Studio ignore it — always
  // openai-completions. `null` = auto-detect (default): the Test probe
  // classifies which chat route the endpoint exposes and snaps the dropdown to
  // that value. Enable requires a concrete flavor; the button stays disabled
  // until Test succeeds or the user picks one explicitly.
  const [api, setApi] = useState<LocalProviderApi | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<LocalProviderTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  // The probe runs for seconds against a URL the user is still typing into, so a
  // late answer must prove it still belongs to this form before it may speak for
  // it: a crossed result restores a cleared badge and fills one endpoint's model
  // ids into another, which Enable then writes to models.json verbatim. The
  // gate covers switching servers or submitting; the value snapshot covers edits
  // to the URL or key, which leave the request itself outstanding. `formRef`
  // mirrors the live values because the post-await closure sees only the ones
  // captured when the test started.
  const testGateRef = useRef(new RequestGate());
  const formRef = useRef({ server, baseUrl, apiKey, models, api });
  formRef.current = { server, baseUrl, apiKey, models, api };
  const custom = server === 'custom';
  const modelList = models
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  function pick(id: LocalProviderId) {
    testGateRef.current.invalidate();
    setServer(id);
    setBaseUrl(settings[id].baseUrl);
    setApiKey('');
    setModels('');
    // Custom starts on Auto-detect; Ollama/LM Studio are always openai-completions.
    setApi(id === 'custom' ? null : 'openai-completions');
    setTest(null);
    setTesting(false);
  }

  async function runTest() {
    const request = testGateRef.current.begin();
    // Auto-detect on Custom sends `undefined` so main runs the OPTIONS probe on
    // both chat routes; a concrete pick from the dropdown short-circuits that.
    // Ollama/LM Studio always name their flavor: they can't be anything but
    // OpenAI-compatible, so sending it spares them two pointless round-trips.
    const probeApi: LocalProviderApi | undefined =
      server === 'custom' ? (api ?? undefined) : 'openai-completions';
    const tested = localProbeTarget(server, baseUrl, apiKey, probeApi ?? 'openai-completions');
    const speaksForTheForm = () => {
      const form = formRef.current;
      const formProbe: LocalProviderApi =
        form.server === 'custom' ? (form.api ?? 'openai-completions') : 'openai-completions';
      return (
        testGateRef.current.isCurrent(request) &&
        probeStillDescribes(tested, localProbeTarget(form.server, form.baseUrl, form.apiKey, formProbe))
      );
    };
    setTesting(true);
    setTest(null);
    try {
      const result = await window.stem.testLocalProvider(
        tested.server,
        tested.baseUrl,
        custom ? tested.apiKey : undefined,
        probeApi
      );
      if (speaksForTheForm()) {
        setTest(result);
        // Auto-detect success snaps the dropdown to what actually answered, so
        // Enable writes the flavor that just tested green.
        if (custom && result.ok && result.api && api === null) setApi(result.api);
        // A listing endpoint that does answer saves the typing — but never
        // overwrite ids the user already chose.
        if (custom && result.ok && result.models?.length && !formRef.current.models.trim())
          setModels(result.models.join(', '));
      }
    } catch {
      if (speaksForTheForm()) setTest({ ok: false, error: 'request failed' });
    } finally {
      // Not snapshot-guarded: an edit mid-probe must still release the button.
      if (testGateRef.current.isCurrent(request)) setTesting(false);
    }
  }

  async function enable() {
    // Nothing in flight may label the form once it has been submitted — and the
    // discarded probe no longer owns the button it left in its testing state.
    testGateRef.current.invalidate();
    setTesting(false);
    setSaving(true);
    onError(null);
    try {
      const res = await window.stem.updateLocalProvider(server, {
        enabled: true,
        baseUrl: baseUrl.trim(),
        // API flavor only meaningful for `custom`; the coercion in settings
        // strips it for other providers. Enable is disabled below when a custom
        // endpoint is still on Auto-detect, so `api` is guaranteed non-null here.
        api: custom ? (api ?? 'openai-completions') : 'openai-completions',
        // Sent even when empty so re-adding a previously keyed endpoint without
        // one clears the stored key instead of silently inheriting it.
        apiKey: custom ? apiKey.trim() : '',
        models: custom ? modelList : []
      });
      if (!res.ok) onError(res.error ?? 'Could not enable the server.');
      else await onSaved();
    } finally {
      setSaving(false);
    }
  }

  const flavorLabel = (a: LocalProviderApi): string =>
    a === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Chat Completions';
  const testLabel = test
    ? test.ok
      ? `${test.models?.length ?? 0} model${(test.models?.length ?? 0) === 1 ? '' : 's'} found` +
        (test.skippedNoTools ? ` (${test.skippedNoTools} without tool support hidden)` : '') +
        // When auto-detect classified the endpoint, name the flavor it picked so
        // the user can see (and re-confirm) the setting Enable will write.
        (custom && test.api ? ` — ${flavorLabel(test.api)}` : '')
      : test.error ?? 'failed'
    : null;

  return (
    <div className="set-block">
      <span className="set-sub">
        Server{' '}
        <InfoTip label="About servers">
          Any OpenAI-compatible or Anthropic-compatible server Stem can register itself, rather than one it already
          knows. <strong>Ollama</strong> and <strong>LM Studio</strong> run on this machine and report their own models
          — LM Studio loads one on first use, so its first reply can take a while. <strong>Custom endpoint</strong> is
          any other URL: a gateway, a proxy, a server elsewhere on your network. Leave the flavor on{' '}
          <em>Auto-detect</em> and Test connection classifies which chat route the endpoint exposes
          (<code>/v1/chat/completions</code> vs <code>/v1/messages</code>) before listing its models — or pick a
          flavor by hand if the server is picky about that OPTIONS probe. Stem strips a trailing <code>/v1</code>
          from your URL and lets the client add the versioned path itself. The key goes on the wire the way the
          target API expects (<code>Authorization: Bearer</code> for OpenAI-flavored servers, <code>X-Api-Key</code>
          for Anthropic). Test connection fills the model IDs in when the endpoint lists them; endpoints that serve
          no listing just need the IDs typed in.
        </InfoTip>
      </span>
      <select
        className="ifield"
        aria-label="Server"
        value={server}
        onChange={(e) => pick(e.target.value as LocalProviderId)}
      >
        {(Object.keys(settings) as LocalProviderId[]).map((id) => (
          <option key={id} value={id}>
            {providerName(id)}
          </option>
        ))}
      </select>
      <input
        className="ifield"
        aria-label={`${providerName(server)} base URL`}
        placeholder={custom ? 'https://api.example.com/v1' : undefined}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      {custom && (
        <>
          <select
            className="ifield"
            aria-label="API flavor"
            value={api ?? ''}
            onChange={(e) => {
              // The probe classification depends on the chosen flavor — or on
              // its absence — so a mid-typed test loses relevance and any
              // auto-filled models were pulled under the old assumption. Clear
              // both like URL changes do.
              testGateRef.current.invalidate();
              const next = e.target.value as LocalProviderApi | '';
              setApi(next === '' ? null : next);
              setTest(null);
              setModels('');
            }}
          >
            <option value="">Auto-detect (Test to classify)</option>
            <option value="openai-completions">OpenAI Chat Completions</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
          <input
            className="ifield"
            type="password"
            aria-label="API key"
            placeholder="API key (leave empty if the server needs none)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <input
            className="ifield"
            aria-label="Model IDs"
            placeholder="Model IDs, comma-separated"
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
        </>
      )}
      <div className="retrieval-test">
        <button
          className="retrieval-test-btn"
          onClick={() => void runTest()}
          disabled={testing}
          title={testing ? 'Testing…' : 'Test connection'}
          aria-label={`Test ${providerName(server)} connection`}
        >
          <Plug size={14} />
          <span>{testing ? 'Testing…' : 'Test connection'}</span>
        </button>
        {!testing && testLabel && (
          <span className={`retrieval-test-status ${test!.ok ? 'ok' : 'err'}`} title={testLabel}>
            {test!.ok ? <Check size={12} /> : <X size={12} />}
            {testLabel}
          </span>
        )}
      </div>
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="push default"
          disabled={saving || !baseUrl.trim() || (custom && modelList.length === 0) || (custom && api === null)}
          onClick={() => void enable()}
        >
          {saving ? 'Enabling…' : 'Enable'}
        </button>
      </div>
    </div>
  );
}
