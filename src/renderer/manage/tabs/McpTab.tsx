import { useEffect, useRef, useState } from 'react';
import { Plus, Minus, ChevronRight } from 'lucide-react';
import type {
  BackendEventEnvelope,
  DeviceInfo,
  McpHostLocalState,
  McpHostPendingServer,
  McpHostServerStatus,
  McpHostSpecPreview,
  McpLoginUrlParams,
  McpServerStatus,
  McpServerSummary,
  McpTransport,
  ModelSummary
} from '../../../shared/types';
import { SkillsTab } from './SkillsTab';
import { useRememberedTab } from '../../hooks/useRememberedTab';
import { useRemoteServer } from '../../hooks/useRemoteServer';

const SUBS = ['mcp', 'skills'] as const;

// Combined panel: MCP servers and Skills live under the same icon as two sub-tabs.
export function McpSkillsTab({ models }: { models: ModelSummary[] }) {
  const [sub, setSub] = useRememberedTab('stem.tools.sub', SUBS, 'mcp');
  return (
    <div>
      <div className="seg-ctl">
        <button className={sub === 'mcp' ? 'active' : ''} onClick={() => setSub('mcp')}>
          MCP servers
        </button>
        <button className={sub === 'skills' ? 'active' : ''} onClick={() => setSub('skills')}>
          Skills
        </button>
      </div>
      {sub === 'mcp' ? <McpTab /> : <SkillsTab models={models} />}
    </div>
  );
}

function McpTab() {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [transport, setTransport] = useState<McpTransport>('http');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [envText, setEnvText] = useState('');
  // Optional static OAuth client for remote servers without dynamic registration
  // (e.g. Slack): you pre-register an app with the provider and paste its creds.
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthScope, setOauthScope] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loginName, setLoginName] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<McpLoginUrlParams | null>(null);
  // Live per-server connection status from the running app-server. This is the
  // source of truth for whether a remote server actually works — `authStatus`
  // only says whether OAuth creds exist on disk, which stays 'o_auth' even when
  // the token is rejected at connect time and the server exposes no tools.
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [selected, setSelected] = useState<string | null>(null);
  // The Add Server form is collapsed by default — the + button reveals it — so the
  // panel stays calm when you're just reviewing servers. `showAdvanced` hides headers
  // and the static OAuth client fields behind a disclosure (most adds are Name + URL).
  const [adding, setAdding] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  // Where a new server should run. '' = on the machine hosting the server, which
  // is where every server has always run and stays the default. Only meaningful
  // when this window is talking to a server somewhere else — see `remote` below.
  const [locationDeviceId, setLocationDeviceId] = useState('');
  const [hosts, setHosts] = useState<DeviceInfo[]>([]);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);
  const remote = useRemoteServer();
  // What THIS computer hosts, says about it, and is waiting to be told. Asked of
  // the desktop and never of the server (see desktop/local/index.ts), so it
  // answers on an install of any age with a server anywhere — including one
  // whose other clients are phones, which host nothing and are never asked to.
  const [hostState, setHostState] = useState<McpHostLocalState>({ approved: {}, pending: [], status: {} });
  const [testing, setTesting] = useState<string | null>(null);

  async function refresh() {
    const [list, status] = await Promise.all([
      window.stem.listMcpServers(),
      window.stem.getMcpStatus()
    ]);
    setServers(list);
    setStatuses(status);
  }

  useEffect(() => {
    refresh();
    // The assistant can add/remove servers itself; refresh the list when it does.
    const offChanged = window.stem.onMcpChanged(() => refresh());
    // Live connection-status updates (e.g. a server goes ready/failed).
    const offStatus = window.stem.onMcpStatus((s) => setStatuses(s));
    return () => {
      offChanged();
      offStatus();
    };
  }, []);

  // The devices that could host a server: paired desktops only, because a phone
  // sleeps and a server on it would be unreachable half the time. Read only when
  // there is a choice to make — a window whose server is this very machine never
  // renders the picker, so it never asks.
  useEffect(() => {
    if (!remote) return;
    void window.stem
      .listDevices()
      .then((snapshot) => setHosts(snapshot.devices.filter((d) => d.kind === 'desktop')))
      .catch(() => undefined);
  }, [remote]);

  // Which device this window is, asked unconditionally: a server can be pinned
  // to this machine on an install that has never been remote (an import, or a
  // pin made before the server moved), and "is this one mine" is the question
  // every host affordance below hangs off.
  useEffect(() => {
    void window.stem
      .clientInfo()
      .then((info) => setThisDeviceId(info.deviceId))
      .catch(() => undefined);
    void window.stem.mcpHostState().then(setHostState).catch(() => undefined);
    // The host settles servers on its own schedule — a handshake finishing, a
    // child dying — so the panel is told rather than polling for it.
    return window.stem.onMcpHostChanged(setHostState);
  }, []);

  // The OAuth authorize URL is streamed mid-login as a fallback link.
  useEffect(() => {
    return window.stem.onBackendEvent((event: BackendEventEnvelope) => {
      if (event.method === 'mcp/login/url') setLoginUrl(event.params as McpLoginUrlParams);
    });
  }, []);

  // Focus the Name field once the form has mounted (the + button opens it).
  useEffect(() => {
    if (adding) nameRef.current?.focus();
  }, [adding]);

  // Apply config/token changes to the live session without an app restart.
  async function reconnect() {
    setBusy('Reconnecting…');
    try {
      await window.stem.restartRuntime();
    } finally {
      setBusy(null);
    }
  }

  const canAdd =
    !!name.trim() && (transport === 'http' ? !!url.trim() : !!command.trim()) && !busy;

  // Collapse the Add Server form and reset every field + disclosure to a clean slate.
  function closeForm() {
    setAdding(false);
    setShowAdvanced(false);
    setName('');
    setCommand('');
    setArgs('');
    setUrl('');
    setEnvText('');
    setOauthClientId('');
    setOauthClientSecret('');
    setOauthScope('');
    setLocationDeviceId('');
    setError(null);
  }

  // Parse the env textarea ("KEY=value" per line) into a map; blank/`#` lines skipped.
  function parseEnv(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  }

  // Parse the headers textarea ("Key: value" or "Key=value" per line).
  function parseHeaders(text: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = trimmed.search(/[:=]/);
      if (i <= 0) continue;
      headers[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
    }
    return headers;
  }

  async function add() {
    setError(null);
    try {
      const headers = transport === 'http' ? parseHeaders(envText) : {};
      const env = transport === 'http' ? {} : parseEnv(envText);
      const list = await window.stem.addMcpServer({
        name: name.trim(),
        transport,
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        url: url.trim(),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(transport === 'http' && oauthClientId.trim() ? { oauthClientId: oauthClientId.trim() } : {}),
        ...(transport === 'http' && oauthClientSecret.trim() ? { oauthClientSecret: oauthClientSecret.trim() } : {}),
        ...(transport === 'http' && oauthScope.trim() ? { oauthScope: oauthScope.trim() } : {}),
        // Sent only when a device was picked: an absent location is what "runs
        // where the server runs" has always looked like on disk.
        ...(locationDeviceId ? { location: { deviceId: locationDeviceId } } : {})
      });
      setServers(list);
      closeForm();
      await reconnect();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function remove(serverName: string) {
    setError(null);
    setServers(await window.stem.removeMcpServer(serverName));
    setSelected((cur) => (cur === serverName ? null : cur));
    setStatuses((prev) => {
      const next = { ...prev };
      delete next[serverName];
      return next;
    });
    await reconnect();
  }

  // Toggle a server on/off without removing it. The bridge only reads mcp.json on
  // (re)start, so a reconnect is required for the change to take effect.
  async function toggleEnabled(serverName: string, enabled: boolean) {
    setError(null);
    setServers(await window.stem.setMcpServerEnabled(serverName, enabled));
    await reconnect();
  }

  async function signIn(serverName: string) {
    setError(null);
    setLoginName(serverName);
    setLoginUrl(null);
    try {
      const result = await window.stem.loginMcpServer(serverName);
      if (result.ok) {
        // reconnect() respawns the app-server, which clears stale statuses and
        // re-emits fresh ones; refresh() then pulls the new snapshot.
        await reconnect();
        await refresh();
      } else {
        setError(result.error ?? 'Sign in failed.');
      }
    } finally {
      setLoginName(null);
      setLoginUrl(null);
    }
  }

  /**
   * Resolve how a URL (http) server should present. Live connection status wins;
   * we fall back to `authStatus` only when the app-server hasn't reported yet
   * (e.g. the panel opened before any thread started this session).
   *   connected — handshook, tools available
   *   failed    — dropped at connect time (OAuth token rejected → offer re-login)
   *   pending   — still starting
   *   needs-login — no usable credentials
   */
  function httpState(s: McpServerSummary): 'connected' | 'failed' | 'pending' | 'needs-login' {
    const live = statuses[s.name]?.status;
    if (live === 'ready') return 'connected';
    if (live === 'failed') return 'failed';
    if (live === 'starting') return 'pending';
    const hasCreds = s.authStatus === 'o_auth' || s.authStatus === 'bearer_token';
    return hasCreds ? 'connected' : 'needs-login';
  }

  /** The machine a server runs on, as a row names it. */
  function placeLabel(s: McpServerSummary): string {
    return s.location ? s.location.label : 'Server';
  }

  function placeClass(s: McpServerSummary): string {
    // An orphaned pin is a real problem — the machine it names is gone — so it
    // reads as one rather than sitting quietly among the ordinary places.
    return `pill ${s.location?.orphaned ? 'danger' : 'place'}`;
  }

  function placeTitle(s: McpServerSummary): string {
    if (s.location?.orphaned) {
      return 'This server is pinned to a device that is no longer paired, so it cannot run anywhere.';
    }
    if (hostedHere(s)) return 'Runs on this computer.';
    if (s.location) {
      return `Runs on “${s.location.label}”, and that computer decides whether it runs — there is nothing to approve or test from here.`;
    }
    return 'Runs on the machine hosting your Stem server.';
  }

  /**
   * Whether this very machine is the one that runs `s`. Everything below is
   * gated on it, and deliberately so: a server pinned to another device is that
   * device's business, and this window has nothing true to say about whether it
   * has been approved, is running, or can be tested. The row names the place and
   * stops there.
   */
  function hostedHere(s: McpServerSummary): boolean {
    return !!thisDeviceId && s.location?.deviceId === thisDeviceId;
  }

  /** How a server running here is doing, as the row's pill or dot. */
  function hostBadge(s: McpServerSummary) {
    const state = hostState.status[s.name]?.status;
    if (state === 'unapproved') {
      return (
        <span className="pill warn" title="This computer has not agreed to run it yet.">
          Needs approval
        </span>
      );
    }
    if (state === 'ready') {
      return <span className="mcp-dot" title="Running on this computer" aria-label="Running" />;
    }
    if (state === 'starting') {
      return <span className="mcp-dot pending" title="Starting…" aria-label="Starting" />;
    }
    // 'failed', or nothing reported yet on a launch where the server has not
    // been asked. The error text is in the row's own line; a second copy in a
    // pill would just be shorter and less useful.
    return state === 'failed' ? <span className="pill danger">Failed</span> : null;
  }

  /** What a spec would actually run, in one line. */
  function previewLine(preview: McpHostSpecPreview): string {
    if (preview.url) return preview.url;
    return [preview.command ?? '', ...(preview.args ?? [])].join(' ').trim();
  }

  /** The names of the credentials a spec carries; the values never leave main. */
  function credentialLine(preview: McpHostSpecPreview): string | null {
    const keys = [...(preview.envKeys ?? []), ...(preview.headerKeys ?? [])];
    if (keys.length === 0) return null;
    return `Carries ${keys.join(', ')} — Stem passes the values through without showing them here.`;
  }

  /** A hosted server's state, in the words the card under the list uses. */
  function hostStateLine(status: McpHostServerStatus | undefined): string {
    if (!status) return 'Not started yet.';
    if (status.status === 'ready') {
      const n = status.tools ?? 0;
      return `Running on this computer — ${n} tool${n === 1 ? '' : 's'}.`;
    }
    if (status.status === 'starting') return 'Starting…';
    if (status.status === 'unapproved') return 'Waiting for your approval.';
    return status.error ?? 'It stopped, and did not say why.';
  }

  async function approveHosted(pending: McpHostPendingServer) {
    setError(null);
    try {
      setHostState(await window.stem.approveMcpHostServer(pending.name, pending.fingerprint));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function rejectHosted(serverName: string) {
    setError(null);
    try {
      setHostState(await window.stem.rejectMcpHostServer(serverName));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  // Connect now and say what happened. This is the only way to see the REAL
  // reason a spec is broken — a missing binary, a URL nothing answers on — and
  // it is why the answer is the whole fresh state rather than an ok/not-ok.
  async function testHosted(serverName: string) {
    setError(null);
    setTesting(serverName);
    try {
      setHostState(await window.stem.testMcpHostServer(serverName));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setTesting(null);
    }
  }

  function signInLabel(serverName: string, state: 'failed' | 'needs-login'): string {
    if (loginName === serverName) return 'Waiting…';
    return state === 'failed' ? 'Reconnect' : 'Sign in';
  }

  return (
    <div>
      <div className="grp-head">MCP Servers</div>
      {servers.length === 0 ? (
        <div className="group">
          <div className="group-row">
            <span className="row-main">
              <em>No servers yet. Add one with the + button.</em>
            </span>
          </div>
        </div>
      ) : (
        <div className="group">
          {servers.map((s) => {
            const viaUrl = s.transport === 'http';
            // A server pinned to a device is not this server's to connect: the
            // bridge routes calls to the machine it belongs to rather than
            // opening the connection here, so the live dot and the sign-in
            // prompt would both be describing somebody else's connection. The
            // place is what the row has to say instead.
            const elsewhere = !!s.location;
            const here = hostedHere(s);
            const state = viaUrl && !elsewhere ? httpState(s) : null;
            const needsLogin = state === 'failed' || state === 'needs-login';
            const error = statuses[s.name]?.error ?? undefined;
            // A server running here reports its own failure, in its own words.
            // The bridge's status map has nothing to say about it: it never
            // tried to connect it, and never will.
            const hereFailed = here && hostState.status[s.name]?.status === 'failed';
            return (
              <div
                key={s.name}
                className={`group-row${selected === s.name ? ' selected' : ''}${s.enabled ? '' : ' disabled'}`}
                onClick={() => setSelected(s.name)}
              >
                <span className="row-main">
                  <strong>{s.name}</strong>
                  <em
                    title={s.enabled && state === 'failed' ? error : undefined}
                    className={s.enabled && (state === 'failed' || hereFailed) ? 'mcp-failed' : undefined}
                  >
                    {s.enabled && hereFailed
                      ? (hostState.status[s.name]?.error ?? 'It did not start on this computer.')
                      : s.enabled && state === 'failed'
                        ? 'Connection failed — sign in again.'
                        : viaUrl
                          ? s.url
                          : `${s.command} ${s.args.join(' ')}`.trim()}
                  </em>
                </span>
                {/* Where it runs, shown only when there is more than one place it
                    could be. On the ordinary install the app and the server are
                    one machine, and naming it would invent a distinction. */}
                {remote && <span className={placeClass(s)} title={placeTitle(s)}>{placeLabel(s)}</span>}
                {!s.enabled ? (
                  <span className="pill off">Disabled</span>
                ) : here ? (
                  hostBadge(s)
                ) : viaUrl && needsLogin ? (
                  <button
                    className="push"
                    onClick={(e) => {
                      e.stopPropagation();
                      signIn(s.name);
                    }}
                    disabled={!!loginName || !!busy}
                  >
                    {signInLabel(s.name, state)}
                  </button>
                ) : viaUrl && !elsewhere ? (
                  <span
                    className={`mcp-dot${state === 'pending' ? ' pending' : ''}`}
                    title={state === 'pending' ? 'Connecting…' : 'Connected'}
                    aria-label={state === 'pending' ? 'Connecting' : 'Connected'}
                  />
                ) : null}
                <button
                  className={`switch${s.enabled ? ' on' : ''}`}
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`${s.name} enabled`}
                  title={s.enabled ? 'Disable server' : 'Enable server'}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleEnabled(s.name, !s.enabled);
                  }}
                  disabled={!!busy || !!loginName}
                />
              </div>
            );
          })}
        </div>
      )}
      <div className="gutter">
        <button title="Add server" onClick={() => (adding ? nameRef.current?.focus() : setAdding(true))}>
          <Plus size={15} />
        </button>
        <button
          title="Remove selected"
          onClick={() => selected && remove(selected)}
          disabled={!selected || !!busy || !!loginName}
        >
          <Minus size={15} />
        </button>
      </div>

      {/* One card per spec this computer has been asked to run and has not
          agreed to. It waits here rather than interrupting at launch (⑥): a
          modal on startup would be answered by whoever wanted it to go away. */}
      {hostState.pending.map((p) => (
        <div key={p.name}>
          <div className="grp-head">
            {p.changed ? `${p.name} changed — approve it again` : `Approve ${p.name} to run here`}
          </div>
          <div className="formgroup">
            <div className="set-block">
              <span className="set-sub">This computer would run</span>
              <code>{previewLine(p.preview)}</code>
              {credentialLine(p.preview) && <p className="muted">{credentialLine(p.preview)}</p>}
              <p className="muted">
                {p.changed
                  ? 'Its command, arguments or credentials are not the ones you approved. Stem stopped it and will not start it again until you say so.'
                  : 'Stem never starts a server on your own computer without being asked, even when the entry was added elsewhere.'}
              </p>
              {/* The one thing the plan insists is visible rather than
                  documented: after this click there are no further questions,
                  so what the click authorizes has to be readable here. */}
              <p className="muted">
                Once approved, Stem starts it and uses its tools whenever the assistant asks — including on a
                scheduled run — without asking again.
              </p>
              {p.unbounded && <p className="error">{p.unbounded}</p>}
              <div className="memory-view-actions">
                <button className="link-btn" onClick={() => approveHosted(p)}>
                  Approve and start
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Everything already running (or trying to) on this machine. Servers
          pinned to another device are absent by construction: this window would
          be guessing about them. */}
      {servers.some((s) => hostedHere(s) && hostState.status[s.name]?.status !== 'unapproved') && (
        <>
          <div className="grp-head">On this computer</div>
          <div className="formgroup">
            {servers
              .filter((s) => hostedHere(s) && hostState.status[s.name]?.status !== 'unapproved')
              .map((s, i) => (
                <div key={s.name} className={`set-block${i === 0 ? '' : ' fg-divider'}`}>
                  <span className="set-sub">{s.name}</span>
                  <p className="muted">{hostStateLine(hostState.status[s.name])}</p>
                  <div className="memory-view-actions">
                    <button
                      className="link-btn"
                      onClick={() => testHosted(s.name)}
                      disabled={testing === s.name}
                    >
                      {testing === s.name ? 'Connecting…' : 'Test connection'}
                    </button>
                    {hostState.approved[s.name] && (
                      <button className="link-btn danger" onClick={() => rejectHosted(s.name)}>
                        Stop trusting
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </>
      )}

      {loginName && loginUrl?.name === loginName && (
        <p className="muted">
          If the browser didn’t open, authorize here:{' '}
          <a href={loginUrl.url} target="_blank" rel="noreferrer">{loginUrl.url}</a>
        </p>
      )}
      {busy && <p className="muted">{busy}</p>}
      {/* The Add Server form renders `error` inside itself; this is the same
          string for everything that can fail with the form closed — approving,
          rejecting or testing a server hosted here. */}
      {error && !adding && <p className="error">{error}</p>}

      {adding && (
        <>
          <div className="grp-head">Add Server</div>
          <div className="formgroup">
            {/* HOW to reach the server, not where it runs: a command to spawn or
                a URL to open. The old Remote|Local labels named the wrong axis —
                "Local" meant a command, which on a hosted Stem is a process in a
                datacentre. Where it runs is the separate control below. */}
            <div className="seg-ctl">
              <button className={transport === 'stdio' ? 'active' : ''} onClick={() => setTransport('stdio')}>
                Command
              </button>
              <button className={transport === 'http' ? 'active' : ''} onClick={() => setTransport('http')}>
                URL
              </button>
            </div>
            {remote && (
              <div className="set-block">
                <span className="set-sub">Runs on</span>
                <select
                  className="ifield"
                  aria-label="Runs on"
                  value={locationDeviceId}
                  onChange={(e) => setLocationDeviceId(e.target.value)}
                >
                  <option value="">Server</option>
                  {hosts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                      {d.id === thisDeviceId ? ' · this computer' : ''}
                    </option>
                  ))}
                </select>
                <p className="muted">
                  Pick a computer for a server that only means anything there — its files, its
                  applications, or a URL on its own network. Phones aren’t offered: they sleep.
                </p>
              </div>
            )}
            <input ref={nameRef} className="ifield" placeholder="Name (e.g. fastmail)" value={name} onChange={(e) => setName(e.target.value)} />
            {transport === 'http' ? (
              <>
                <input className="ifield" placeholder="https://api.fastmail.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
                <button
                  className="memory-view-toggle"
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  <ChevronRight size={14} className={showAdvanced ? 'open' : ''} />
                  <strong>Advanced — headers, OAuth client</strong>
                </button>
                {showAdvanced && (
                  <>
                    <textarea
                      className="ifield"
                      placeholder="headers (optional), one per line — e.g. Authorization: Bearer …"
                      rows={2}
                      value={envText}
                      onChange={(e) => setEnvText(e.target.value)}
                    />
                    <div className="grp-head">OAuth sign-in (optional)</div>
                    <input
                      className="ifield"
                      placeholder="OAuth Client ID — for providers without auto-registration (e.g. Slack)"
                      value={oauthClientId}
                      onChange={(e) => setOauthClientId(e.target.value)}
                    />
                    <input
                      className="ifield"
                      type="password"
                      placeholder="OAuth Client Secret (if the provider is a confidential client)"
                      value={oauthClientSecret}
                      onChange={(e) => setOauthClientSecret(e.target.value)}
                    />
                    <input
                      className="ifield"
                      placeholder="OAuth Scopes (space-separated, must match the provider app)"
                      value={oauthScope}
                      onChange={(e) => setOauthScope(e.target.value)}
                    />
                    {oauthClientId.trim() && (
                      <p className="muted">
                        Register this exact redirect URL in the provider app:{' '}
                        <code>http://127.0.0.1:41759/callback</code>
                      </p>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <input className="ifield" placeholder="command (e.g. npx)" value={command} onChange={(e) => setCommand(e.target.value)} />
                <input className="ifield" placeholder="args (space-separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
                <button
                  className="memory-view-toggle"
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  <ChevronRight size={14} className={showAdvanced ? 'open' : ''} />
                  <strong>Advanced — environment variables</strong>
                </button>
                {showAdvanced && (
                  <textarea
                    className="ifield"
                    placeholder="env (optional), one KEY=value per line"
                    rows={2}
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                  />
                )}
              </>
            )}
            <div className="push-row">
              <button className="push" onClick={closeForm} disabled={!!busy}>Cancel</button>
              <button className="push default" onClick={add} disabled={!canAdd}>Add Server</button>
            </div>
            {transport === 'http' && (
              <p className="muted">
                Most URL servers just need a name and URL — add it, then use “Sign in” to authorize
                via OAuth where supported. For a static token, add an <code>Authorization: Bearer …</code>{' '}
                header under Advanced.
              </p>
            )}
            {error && <p className="error">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
