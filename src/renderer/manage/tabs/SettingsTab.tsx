import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Plug, Globe, HardDrive, Plus, Minus, X, Check, RefreshCw } from 'lucide-react';
import type {
  AuthProviderId,
  ApiKeyProviderId,
  CustomInstructionsSettings,
  EscapeAction,
  ExecSettings,
  NativeWebSearchSettings,
  QuickChatSettings,
  LocalProviderId,
  LocalProvidersSettings,
  LocalProviderTestResult
} from '../../../shared/types';
import { API_KEY_PROVIDER_IDS, AUTH_PROVIDER_IDS, isLocalProviderId, providerName } from '../../../shared/providers';
import { formatAccelerator, IS_MAC, splitAccelerator } from '../../accel';
import { InfoTip } from '../../ui/InfoTip';
import { ModelPicker } from '../../ui/ModelPicker';
import { EFFORT_LABELS } from '../../modelLabels';
import type { ModelTabProps } from './shared';

// Inactivity presets for starting a fresh Quick Chat thread on re-summon.
// 0 = never (always continue the current session).
const NEW_THREAD_PRESETS: { label: string; ms: number }[] = [
  { label: 'Off', ms: 0 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 5 * 60_000 },
  { label: '15m', ms: 15 * 60_000 }
];

// ---- Settings tab: Quick Chat overlay configuration ----

/**
 * Map a physical `KeyboardEvent.code` to an Electron accelerator key token.
 * Using `code` (not `key`) is essential: with Option held, macOS composes
 * `key` into a non-ASCII glyph (Option+J → "∆"), which Electron's accelerator
 * parser rejects. `code` is layout- and modifier-independent. Returns null for
 * unsupported/pure-modifier keys.
 */
function codeToAccelerator(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // KeyJ -> J
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit1 -> 1
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code; // F1..F24
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  const NUMPAD: Record<string, string> = {
    NumpadDecimal: 'numdec',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadEnter: 'Return'
  };
  if (code in NUMPAD) return NUMPAD[code];
  const MAP: Record<string, string> = {
    Space: 'Space',
    Enter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`'
  };
  return MAP[code] ?? null;
}

/** Render an Electron accelerator for display: mac glyphs (a four-modifier
 *  hyperkey collapses to the accented hyper icon), plus-joined text elsewhere. */
function renderAccelerator(accel: string): ReactNode {
  const { isHyper, keys } = splitAccelerator(accel);
  if (IS_MAC && isHyper) {
    return (
      <span className="accel">
        <span className="accel-hyper" aria-label="Hyper">✦</span>
        {keys.join('')}
      </span>
    );
  }
  return <span className="accel">{formatAccelerator(accel)}</span>;
}

function ShortcutRecorder({
  value,
  onChange
}: {
  value: string | null;
  onChange: (accel: string | null) => void;
}) {
  const [recording, setRecording] = useState(false);

  function onKeyDown(e: React.KeyboardEvent) {
    e.preventDefault();
    if (e.code === 'Escape') {
      setRecording(false);
      return;
    }
    const main = codeToAccelerator(e.code);
    if (!main) return; // waiting for a non-modifier / supported key
    const mods: string[] = [];
    // The meta key is ⌘ on mac and the Super/Windows key elsewhere — both are
    // valid Electron accelerator tokens, but only for their own platform.
    if (e.metaKey) mods.push(IS_MAC ? 'Command' : 'Super');
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (mods.length === 0) return; // a global shortcut needs a modifier
    onChange([...mods, main].join('+'));
    setRecording(false);
  }

  return (
    <button
      className={`recorder${recording ? ' recording' : ''}`}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={recording ? onKeyDown : undefined}
    >
      <span>{recording ? 'Press keys…' : value ? renderAccelerator(value) : 'Click to record'}</span>
      {value && !recording && (
        <span
          className="recorder-clear"
          title="Clear shortcut"
          onClick={(e) => {
            e.stopPropagation();
            onChange(null);
          }}
        >
          <X size={12} />
        </span>
      )}
    </button>
  );
}

// ---- AI providers (Settings → top section) ----

const OAUTH_CHOICES: { id: AuthProviderId; hint: string }[] = [
  { id: 'openai-codex', hint: 'Sign in with a ChatGPT Plus or Pro subscription.' },
  { id: 'anthropic', hint: 'Sign in with a Claude Pro or Max subscription.' }
];

/** How a connected provider signed in — shown as the row's secondary line. */
function providerKind(id: string): string {
  if (id === 'openai-codex') return 'ChatGPT subscription';
  if (isLocalProviderId(id)) return 'Local server';
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
    setOauth({ provider, authUrl: null, progress: null, input: null });
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
    ...enabledLocals.map((id) => ({ id, local: true, detail: local![id].baseUrl }))
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
                  <button className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>
                    Local server
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
 * Add a local model server (Ollama / LM Studio): pick the server, adjust the
 * URL if needed, optionally Test, then Enable. Editing later = disconnect (−)
 * and re-add, matching the MCP servers list.
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
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<LocalProviderTestResult | null>(null);
  const [saving, setSaving] = useState(false);

  function pick(id: LocalProviderId) {
    setServer(id);
    setBaseUrl(settings[id].baseUrl);
    setTest(null);
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await window.stem.testLocalProvider(server, baseUrl));
    } catch {
      setTest({ ok: false, error: 'request failed' });
    } finally {
      setTesting(false);
    }
  }

  async function enable() {
    setSaving(true);
    onError(null);
    try {
      const res = await window.stem.updateLocalProvider(server, { enabled: true, baseUrl: baseUrl.trim() });
      if (!res.ok) onError(res.error ?? 'Could not enable the server.');
      else await onSaved();
    } finally {
      setSaving(false);
    }
  }

  const testLabel = test
    ? test.ok
      ? `${test.models?.length ?? 0} model${(test.models?.length ?? 0) === 1 ? '' : 's'} found` +
        (test.skippedNoTools ? ` (${test.skippedNoTools} without tool support hidden)` : '')
      : test.error ?? 'failed'
    : null;

  return (
    <div className="set-block">
      <select
        className="ifield"
        aria-label="Local server"
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
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
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
      {server === 'lmstudio' && (
        <p className="muted">LM Studio loads a model on first use — the first reply can take a while.</p>
      )}
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="push default"
          disabled={saving || !baseUrl.trim()}
          onClick={() => void enable()}
        >
          {saving ? 'Enabling…' : 'Enable'}
        </button>
      </div>
    </div>
  );
}

export function SettingsTab({
  models,
  modelId,
  onSelectModel,
  deadProvider
}: ModelTabProps & { deadProvider?: string | null }) {
  const [qc, setQc] = useState<QuickChatSettings | null>(null);
  const [nws, setNws] = useState<NativeWebSearchSettings>({ main: true, quickChat: true });
  const [escapeAction, setEscapeAction] = useState<EscapeAction>('off');
  const [ci, setCi] = useState<CustomInstructionsSettings>({ main: '', quickChat: '' });
  const [exec, setExec] = useState<ExecSettings | null>(null);
  const [allowInput, setAllowInput] = useState('');
  // Per-field debounce so typing doesn't spam the atomic settings writer.
  const ciMainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ciQuickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedModel = models.find((m) => m.id === modelId) ?? null;

  useEffect(() => {
    window.stem.getSettings().then((s) => {
      setQc(s.quickChat);
      setNws(s.nativeWebSearch);
      setEscapeAction(s.escapeAction);
      setCi(s.customInstructions);
      setExec(s.exec);
    });
  }, []);

  function updateExec(patch: Partial<ExecSettings>) {
    setExec((cur) => (cur ? { ...cur, ...patch } : cur)); // optimistic; reconcile below
    window.stem.updateExecSettings(patch).then((s) => setExec(s.exec));
  }

  function saveCiMain(value: string) {
    setCi((c) => ({ ...c, main: value }));
    if (ciMainTimer.current) clearTimeout(ciMainTimer.current);
    ciMainTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ main: value }), 400);
  }

  function saveCiQuick(value: string) {
    setCi((c) => ({ ...c, quickChat: value }));
    if (ciQuickTimer.current) clearTimeout(ciQuickTimer.current);
    ciQuickTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ quickChat: value }), 400);
  }

  function selectEscapeAction(action: EscapeAction) {
    setEscapeAction(action); // optimistic; persist + reconcile from the saved settings
    // Notify the main window's composer (App) so the new mode applies immediately,
    // without waiting for a window focus cycle.
    window.dispatchEvent(new CustomEvent('stem:escape-action', { detail: action }));
    window.stem.updateEscapeAction(action).then((s) => setEscapeAction(s.escapeAction));
  }

  function update(patch: Partial<QuickChatSettings>) {
    window.stem.updateQuickChat(patch).then((s) => setQc(s.quickChat));
  }

  function toggleNativeSearch(key: keyof NativeWebSearchSettings, enabled: boolean) {
    window.stem.updateNativeWebSearch({ [key]: enabled }).then((s) => setNws(s.nativeWebSearch));
  }

  if (!qc) return <p className="muted">Loading…</p>;

  // The Quick Chat default-effort options follow the chosen default model's capabilities.
  // "Same as main" (empty) has no concrete model here, so offer all levels.
  const qcModel = qc.defaultModel ? models.find((m) => m.id === qc.defaultModel) : undefined;
  const qcEfforts = qcModel?.supportedEfforts.length ? qcModel.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
  // Only models with a priority (Fast) tier can default to Fast. With no concrete model
  // ("Same as main"), offer it — the runtime ignores Fast on models that don't support it.
  const qcHasFast = qcModel ? qcModel.serviceTiers.some((t) => t.id === 'priority') : true;

  // Switch the default model, clamping a now-unsupported saved effort/speed into range.
  function selectQcModel(id: string | null) {
    const m = id ? models.find((x) => x.id === id) : undefined;
    const efforts = m?.supportedEfforts.length ? m.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
    const patch: Partial<QuickChatSettings> = { defaultModel: id };
    if (qc && !efforts.includes(qc.defaultEffort)) patch.defaultEffort = m?.defaultEffort ?? efforts[0];
    // Drop a saved Fast default when the new model has no priority tier.
    if (qc?.defaultServiceTier === 'priority' && m && !m.serviceTiers.some((t) => t.id === 'priority')) {
      patch.defaultServiceTier = null;
    }
    update(patch);
  }

  return (
    <div>
      <div className="grp-head">Model</div>
      <div className="formgroup">
        {models.length === 0 ? (
          <p className="muted">Loading models…</p>
        ) : (
          <>
            <ModelPicker
              models={models}
              value={modelId}
              onChange={(id) => onSelectModel(id ?? '')}
              ariaLabel="Model"
            />
            {selectedModel?.supportsNativeWebSearch && (
              <label className="set-check" title="Search the live web for current info, with citations">
                <input
                  type="checkbox"
                  checked={nws.main}
                  onChange={(e) => toggleNativeSearch('main', e.target.checked)}
                />
                Native web search
              </label>
            )}
          </>
        )}
      </div>

      <ProvidersSection deadProvider={deadProvider} />

      {/* The Files folder lives in the Sources tab (Files sub-tab) — it is a
          source the assistant reads from, not an app setting. */}

      <div className="grp-head">Input</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Escape key{' '}
            <InfoTip label="What Escape does while streaming">
              While a reply is streaming, Escape can stop it and return your just-sent message to
              the composer to edit — as if you never sent it.
            </InfoTip>
          </span>
          <div className="seg-ctl">
            <button
              className={escapeAction === 'off' ? 'active' : ''}
              onClick={() => selectEscapeAction('off')}
              title="Escape does nothing in the composer"
            >
              Off
            </button>
            <button
              className={escapeAction === 'single' ? 'active' : ''}
              onClick={() => selectEscapeAction('single')}
              title="One Escape stops the turn and pulls your message back into the composer"
            >
              Single
            </button>
            <button
              className={escapeAction === 'twoStage' ? 'active' : ''}
              onClick={() => selectEscapeAction('twoStage')}
              title="First Escape stops the turn; a second Escape retracts your message"
            >
              Two-stage
            </button>
          </div>
        </div>
      </div>

      <div className="grp-head">Custom instructions</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Standing instructions{' '}
            <InfoTip label="About standing instructions">
              High-priority directives Stem follows in every reply — in the main app and in Quick
              Chat. Stem can also update these itself when you ask it to.
            </InfoTip>
          </span>
          <textarea
            className="ci-textarea"
            value={ci.main}
            onChange={(e) => saveCiMain(e.target.value)}
            rows={5}
            placeholder="e.g. Reply briefly and to the point. Use plain Markdown unless I ask for components."
          />
        </div>
      </div>

      <div className="grp-head">Command execution</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Run commands</strong>
            <em>
              Let Stem run shell commands (CLIs, git, agent-browser){' '}
              <InfoTip label="How command approval works">
                What runs on its own is governed by the approval mode below — from manual (you
                approve everything unlisted) to yolo (everything runs). Folders you marked
                read-only are always protected.
              </InfoTip>
            </em>
          </span>
          <button
            className={`switch${exec?.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={exec?.enabled ?? false}
            aria-label="Run commands"
            onClick={() => exec && updateExec({ enabled: !exec.enabled })}
          />
        </div>

        {exec?.enabled && (
          <>
            <div className="set-block">
              <span className="set-sub">
                Approval mode{' '}
                <InfoTip label="About approval modes">
                  <strong>Manual</strong> — only allowlisted commands run on their own; everything
                  else pauses for your approval. <strong>Assisted</strong> — an AI safety check
                  clears commands that serve your request; only flagged ones pause.{' '}
                  <strong>Yolo</strong> — every command runs immediately, no questions asked (folders
                  you marked read-only stay protected). The safety check is a heuristic, not a
                  security boundary.
                </InfoTip>
              </span>
              <div className="seg-ctl">
                <button
                  className={exec.approvalMode === 'manual' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'manual' })}
                >
                  Manual
                </button>
                <button
                  className={exec.approvalMode === 'assisted' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'assisted' })}
                >
                  Assisted
                </button>
                <button
                  className={exec.approvalMode === 'yolo' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'yolo' })}
                  title="Every command runs immediately — use with care"
                >
                  Yolo
                </button>
              </div>
            </div>

            {exec.approvalMode === 'assisted' && (
              <div className="set-block">
                <span className="set-sub">Safety-check model</span>
                <ModelPicker
                  models={models}
                  value={exec.judgeModel}
                  onChange={(id) => updateExec({ judgeModel: id })}
                  emptyLabel="Auto (cheapest)"
                  ariaLabel="Safety-check model"
                />
              </div>
            )}

            {exec.approvalMode !== 'yolo' && (
              <div className="set-block">
                <span className="set-sub">
                  Always-allowed commands{' '}
                  <InfoTip label="About the allowlist">
                    Command prefixes that run without the safety check — grown by the approval card's
                    "Always allow" button or added here (e.g. <code>git push</code> or <code>npm</code>).
                  </InfoTip>
                </span>
                {exec.allowlist.length > 0 && (
                  <div className="exec-allowlist">
                    {exec.allowlist.map((prefix) => (
                      <span key={prefix} className="pill">
                        {prefix}
                        <button
                          title={`Remove "${prefix}"`}
                          aria-label={`Remove "${prefix}" from the allowlist`}
                          onClick={() => updateExec({ allowlist: exec.allowlist.filter((p) => p !== prefix) })}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const prefix = allowInput.trim();
                    if (!prefix || exec.allowlist.includes(prefix)) return;
                    updateExec({ allowlist: [...exec.allowlist, prefix] });
                    setAllowInput('');
                  }}
                >
                  <input
                    className="ifield"
                    type="text"
                    placeholder="Add a prefix, e.g. git push"
                    aria-label="Add an allowlisted command prefix"
                    value={allowInput}
                    onChange={(e) => setAllowInput(e.target.value)}
                  />
                </form>
              </div>
            )}
          </>
        )}
      </div>

      <div className="grp-head">Quick Chat</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Global shortcut</strong>
            <em>Summon the quick-chat overlay from anywhere</em>
          </span>
          <ShortcutRecorder value={qc.shortcut} onChange={(accel) => update({ shortcut: accel })} />
        </div>
        {window.stem.platform === 'linux' && (
          <div className="set-row">
            <span className="set-label">
              <em>
                On Wayland, global shortcuts may not fire — bind a system keyboard shortcut to{' '}
                <code>stem --quick-chat</code> instead.
              </em>
            </span>
          </div>
        )}

        <div className="set-block">
          <span className="set-sub">Default model</span>
          <ModelPicker
            models={models}
            value={qc.defaultModel}
            onChange={selectQcModel}
            emptyLabel="Same as main"
            ariaLabel="Quick Chat default model"
          />
          {qcModel?.supportsNativeWebSearch && (
            <label className="set-check" title="Search the live web for current info, with citations">
              <input
                type="checkbox"
                checked={nws.quickChat}
                onChange={(e) => toggleNativeSearch('quickChat', e.target.checked)}
              />
              Native web search
            </label>
          )}
        </div>

        <div className="set-block">
          <span className="set-sub">Default effort</span>
          <div className="seg-ctl">
            {qcEfforts.map((e) => (
              <button key={e} className={qc.defaultEffort === e ? 'active' : ''} onClick={() => update({ defaultEffort: e })}>
                {EFFORT_LABELS[e] ?? e}
              </button>
            ))}
          </div>
        </div>

        {qcHasFast && (
          <div className="set-block">
            <span className="set-sub">Default speed</span>
            <div className="seg-ctl">
              <button
                className={qc.defaultServiceTier === 'priority' ? '' : 'active'}
                onClick={() => update({ defaultServiceTier: null })}
              >
                Standard
              </button>
              <button
                className={qc.defaultServiceTier === 'priority' ? 'active' : ''}
                onClick={() => update({ defaultServiceTier: 'priority' })}
                title="1.5× speed, increased usage"
              >
                Fast
              </button>
            </div>
          </div>
        )}

        <div className="set-row">
          <span className="set-label">
            <strong>Show on all displays</strong>
            <em>Float above every Space &amp; the active display</em>
          </span>
          <button
            className={`switch${qc.showOnAllDisplays ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.showOnAllDisplays}
            aria-label="Show on all displays"
            onClick={() => update({ showOnAllDisplays: !qc.showOnAllDisplays })}
          />
        </div>

        <div className="set-row">
          <span className="set-label">
            <strong>Show progress on other Spaces</strong>
            <em>Float the progress pill when the main window loses focus &amp; a thread is running</em>
          </span>
          <button
            className={`switch${qc.followAcrossSpaces ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.followAcrossSpaces}
            aria-label="Show progress on other Spaces"
            onClick={() => update({ followAcrossSpaces: !qc.followAcrossSpaces })}
          />
        </div>

        <div className="set-row">
          <span className="set-label">
            <strong>Sound when finished</strong>
            <em>Play a chime when a turn finishes while the progress pill is visible</em>
          </span>
          <button
            className={`switch${qc.finishSound ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.finishSound}
            aria-label="Sound when finished"
            onClick={() => update({ finishSound: !qc.finishSound })}
          />
        </div>

        <div className="set-block">
          <span className="set-sub">New thread after idle</span>
          <div className="seg-ctl">
            {NEW_THREAD_PRESETS.map((p) => (
              <button
                key={p.label}
                className={qc.newThreadTimeoutMs === p.ms ? 'active' : ''}
                onClick={() => update({ newThreadTimeoutMs: p.ms })}
                title="Re-summoning the overlay after this idle time starts a fresh thread"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="set-block">
          <span className="set-sub">Extra instructions</span>
          <textarea
            className="ci-textarea"
            value={ci.quickChat}
            onChange={(e) => saveCiQuick(e.target.value)}
            rows={4}
            placeholder="e.g. Be even more terse here — one or two sentences."
          />
          <p className="muted">Layered on top of your main custom instructions, only in the Quick Chat overlay.</p>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 'var(--sp-5)' }}>
        Press the shortcut to open the overlay; Escape or the shortcut again hides it.
      </p>
    </div>
  );
}
