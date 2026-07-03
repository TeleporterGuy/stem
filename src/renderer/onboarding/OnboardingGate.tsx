import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { AuthProviderId, ApiKeyProviderId, AuthUiEvent, RuntimeStatus } from '../../shared/types';

// First-run / re-auth gate: the wizard shown instead of the app until Stem holds
// working provider credentials. Drives the main-process ProviderAuth over IPC:
// providerLogin() opens the system browser and resolves when auth.json is
// written; progress (auth URL, manual-code request, failure) arrives as
// auth:event pushes. 'firstRun' walks Welcome → sign-in; 'reauth' (credentials
// lost/expired later) skips the welcome and offers a way back to the chat.

const PROVIDER_LABELS: Record<AuthProviderId, string> = {
  anthropic: 'Claude',
  'openai-codex': 'ChatGPT'
};

type Step = 'welcome' | 'chooseProvider' | 'oauthWait' | 'apiKey' | 'manualInput' | 'finishing' | 'error';

interface WizardState {
  step: Step;
  provider: AuthProviderId | null;
  authUrl: string | null;
  deviceCode: { userCode: string; verificationUri: string } | null;
  progress: string | null;
  inputRequest: { requestId: string; message: string; placeholder?: string } | null;
  error: string | null;
}

type WizardAction =
  | { type: 'continue' }
  | { type: 'pickProvider'; provider: AuthProviderId }
  | { type: 'pickApiKey' }
  | { type: 'backToChoice' }
  | { type: 'finishing' }
  | { type: 'authEvent'; event: AuthUiEvent }
  | { type: 'fail'; error: string };

function initialState(variant: 'firstRun' | 'reauth'): WizardState {
  return {
    step: variant === 'firstRun' ? 'welcome' : 'chooseProvider',
    provider: null,
    authUrl: null,
    deviceCode: null,
    progress: null,
    inputRequest: null,
    error: null
  };
}

function reduce(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'continue':
      return { ...state, step: 'chooseProvider' };
    case 'pickProvider':
      return {
        ...state,
        step: 'oauthWait',
        provider: action.provider,
        authUrl: null,
        deviceCode: null,
        progress: null,
        inputRequest: null,
        error: null
      };
    case 'pickApiKey':
      return { ...state, step: 'apiKey', provider: null, error: null };
    case 'backToChoice':
      return { ...initialState('reauth'), step: 'chooseProvider' };
    case 'finishing':
      return { ...state, step: 'finishing' };
    case 'fail':
      return { ...state, step: 'error', error: action.error };
    case 'authEvent': {
      const e = action.event;
      // Ignore stray pushes when no attempt is in flight (a superseded login).
      if (state.step !== 'oauthWait' && state.step !== 'manualInput' && state.step !== 'finishing') return state;
      switch (e.kind) {
        case 'auth-url':
          return { ...state, authUrl: e.url };
        case 'device-code':
          return { ...state, deviceCode: { userCode: e.userCode, verificationUri: e.verificationUri } };
        case 'progress':
          return { ...state, progress: e.message };
        case 'input-request':
          return {
            ...state,
            step: 'manualInput',
            inputRequest: { requestId: e.requestId, message: e.message, placeholder: e.placeholder }
          };
        case 'done':
          return e.ok ? { ...state, step: 'finishing' } : { ...state, step: 'error', error: e.error };
        default:
          return state;
      }
    }
  }
}

export interface OnboardingGateProps {
  variant: 'firstRun' | 'reauth';
  /** Why re-auth is needed (the failing turn's error); reauth variant only. */
  reauthMessage?: string | null;
  /** Sign-in finished — the parent swaps in the main app with this status. */
  onAuthenticated: (status: RuntimeStatus) => void;
  /** Reauth was a false alarm — go back to the chat. */
  onDismissReauth?: () => void;
}

export function OnboardingGate({ variant, reauthMessage, onAuthenticated, onDismissReauth }: OnboardingGateProps) {
  const [state, dispatch] = useReducer(reduce, variant, initialState);
  // The finish path runs in async handlers after awaits — guard against unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => window.stem.onAuthEvent((event) => dispatch({ type: 'authEvent', event })), []);

  const finish = useCallback(
    async (status: RuntimeStatus | undefined) => {
      dispatch({ type: 'finishing' });
      if (variant === 'firstRun') await window.stem.completeOnboarding().catch(() => undefined);
      const next = status ?? (await window.stem.runtimeStatus());
      if (mountedRef.current) onAuthenticated(next);
    },
    [variant, onAuthenticated]
  );

  const startOAuth = useCallback(
    async (provider: AuthProviderId) => {
      dispatch({ type: 'pickProvider', provider });
      const res = await window.stem.providerLogin(provider);
      if (!mountedRef.current) return;
      if (res.ok) await finish(res.status);
      else dispatch({ type: 'fail', error: res.error ?? 'Sign-in failed.' });
    },
    [finish]
  );

  const cancelOAuth = useCallback(() => {
    void window.stem.providerLoginCancel();
    dispatch({ type: 'backToChoice' });
  }, []);

  const saveApiKey = useCallback(
    async (provider: ApiKeyProviderId, key: string) => {
      const res = await window.stem.setApiKey(provider, key);
      if (!mountedRef.current) return;
      if (res.ok) await finish(res.status);
      else dispatch({ type: 'fail', error: res.error ?? 'The API key could not be saved.' });
    },
    [finish]
  );

  const submitManualCode = useCallback(
    (value: string) => {
      const req = state.inputRequest;
      if (!req) return;
      void window.stem.providerLoginRespond(req.requestId, value);
      // Return to the waiting view; the login promise resolves the flow.
      dispatch({ type: 'pickProvider', provider: state.provider ?? 'anthropic' });
    },
    [state.inputRequest, state.provider]
  );

  const providerLabel = state.provider ? PROVIDER_LABELS[state.provider] : 'the provider';

  return (
    <div className="app gate">
      <div className="gate-card onboarding">
        {state.step === 'welcome' && (
          <>
            <h1>Welcome to Stem</h1>
            <p>A private AI assistant that lives on your Mac.</p>
            <p className="gate-sub">
              Stem brings your own AI account: sign in with a Claude or ChatGPT subscription (or an API
              key). Your chats, files, and memory stay on this Mac.
            </p>
            <button className="primary" onClick={() => dispatch({ type: 'continue' })}>
              Get started
            </button>
          </>
        )}

        {state.step === 'chooseProvider' && (
          <>
            <h1>{variant === 'reauth' ? 'Sign in again' : 'Sign in'}</h1>
            {variant === 'reauth' && (
              <p className="gate-sub">
                {reauthMessage
                  ? `Stem's connection to your AI account stopped working: ${reauthMessage}`
                  : 'Stem needs you to sign in to your AI account again.'}
              </p>
            )}
            <div className="gate-providers">
              <button className="primary" onClick={() => void startOAuth('anthropic')}>
                Continue with Claude
              </button>
              <span className="gate-hint">Claude Pro or Max subscription</span>
              <button className="primary" onClick={() => void startOAuth('openai-codex')}>
                Continue with ChatGPT
              </button>
              <span className="gate-hint">ChatGPT Plus or Pro subscription</span>
            </div>
            <button className="gate-link" onClick={() => dispatch({ type: 'pickApiKey' })}>
              Use an API key instead
            </button>
            {variant === 'reauth' && onDismissReauth && (
              <button className="gate-link" onClick={onDismissReauth}>
                Back to chat
              </button>
            )}
          </>
        )}

        {state.step === 'oauthWait' && (
          <>
            <h1>Waiting for your browser…</h1>
            <p className="gate-sub">
              We opened {providerLabel}'s sign-in page in your browser. Finish signing in there — Stem
              will continue automatically.
            </p>
            {state.deviceCode && (
              <p className="gate-sub">
                Enter code <code className="gate-code">{state.deviceCode.userCode}</code> at{' '}
                {state.deviceCode.verificationUri}
              </p>
            )}
            {state.authUrl && (
              <p className="gate-hint">
                Nothing happened? Open this link yourself:
                <br />
                <code className="login-cmd">{state.authUrl}</code>
              </p>
            )}
            {state.progress && <p className="gate-hint">{state.progress}</p>}
            <button className="push" onClick={cancelOAuth}>
              Cancel
            </button>
          </>
        )}

        {state.step === 'manualInput' && state.inputRequest && (
          <ManualCodeForm
            message={state.inputRequest.message}
            placeholder={state.inputRequest.placeholder}
            onSubmit={submitManualCode}
            onCancel={cancelOAuth}
          />
        )}

        {state.step === 'apiKey' && <ApiKeyForm onSave={saveApiKey} onBack={() => dispatch({ type: 'backToChoice' })} />}

        {state.step === 'finishing' && (
          <>
            <h1>Setting things up…</h1>
            <p className="gate-sub">Signed in. Picking a default model and starting the assistant.</p>
          </>
        )}

        {state.step === 'error' && (
          <>
            <h1>Sign-in didn't finish</h1>
            <p className="error">{state.error}</p>
            <p className="gate-hint">
              If another sign-in was already running (here or in a terminal), close it and try again.
            </p>
            <button className="primary" onClick={() => dispatch({ type: 'backToChoice' })}>
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ManualCodeForm({
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
    <>
      <h1>Almost there</h1>
      <p className="gate-sub">{message}</p>
      <form
        className="gate-form"
        onSubmit={(e) => {
          e.preventDefault();
          const value = inputRef.current?.value.trim();
          if (value) onSubmit(value);
        }}
      >
        <input ref={inputRef} type="text" placeholder={placeholder ?? 'Paste the code here'} autoFocus />
        <div className="gate-form-actions">
          <button type="button" className="push" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Continue
          </button>
        </div>
      </form>
    </>
  );
}

function ApiKeyForm({
  onSave,
  onBack
}: {
  onSave: (provider: ApiKeyProviderId, key: string) => void;
  onBack: () => void;
}) {
  const keyRef = useRef<HTMLInputElement>(null);
  const providerRef = useRef<HTMLSelectElement>(null);
  return (
    <>
      <h1>Use an API key</h1>
      <p className="gate-sub">Paste a key from your Anthropic or OpenAI account. It's stored only on this Mac.</p>
      <form
        className="gate-form"
        onSubmit={(e) => {
          e.preventDefault();
          const key = keyRef.current?.value.trim();
          const provider = (providerRef.current?.value as ApiKeyProviderId) ?? 'anthropic';
          if (key) onSave(provider, key);
        }}
      >
        <select ref={providerRef} defaultValue="anthropic" aria-label="API key provider">
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
        </select>
        <input ref={keyRef} type="password" placeholder="sk-…" autoFocus />
        <div className="gate-form-actions">
          <button type="button" className="push" onClick={onBack}>
            Back
          </button>
          <button type="submit" className="primary">
            Save key
          </button>
        </div>
      </form>
    </>
  );
}
