import { useEffect, useRef, useState } from 'react';
import { Plus, Minus, ChevronRight, Info } from 'lucide-react';
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

/**
 * Why a URL server pinned to one of your computers has no Sign in button.
 *
 * Not an oversight and not a shortcut. OAuth discovery and dynamic client
 * registration are HTTP calls to the server's own address, and sign-in runs on
 * the machine holding your Stem server — which, for `http://homeassistant.local`,
 * has no route to it at all. The half that could work (the browser leg) is not
 * the half that decides. A static token in an `Authorization:` header travels
 * with the spec and works today, so that is what the row offers instead of a
 * button that would fail in a way nobody could read.
 */
const NO_OAUTH_ELSEWHERE =
  'Signing in with OAuth is not available for a server pinned to one of your computers: the sign-in runs where your ' +
  'Stem server runs, and it cannot reach an address on your home network. Use a static token instead — add an ' +
  '“Authorization: Bearer …” header to the entry.';

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
  // Which explanations are open. A panel section should be the thing you came to
  // do — here, two or three buttons — and the reasoning behind it is worth one
  // click, not three paragraphs above the buttons every time you pass through.
  const [explaining, setExplaining] = useState<Record<string, boolean>>({});
  // Which approval card the row's "Approve…" just jumped to. The card can be a
  // long way down a panel that already has several sections, so landing on it
  // silently reads as "the button did nothing" — which is exactly how the first
  // version of this was reported. The class clears itself.
  const [flashPending, setFlashPending] = useState<string | null>(null);

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
    // The assistant can add/remove servers itself; refresh the list when it does
    // — and so can this computer's own host, because what it was asked to run
    // may be exactly what changed. The server tells the hosting machine on its
    // own (see writeServers in server/pi/mcp.ts); this is the open panel
    // catching up, which is a different question with a different answer.
    const offChanged = window.stem.onMcpChanged(() => {
      void refresh();
      void window.stem.refreshMcpHost().then(setHostState).catch(() => undefined);
    });
    // Live connection-status updates (e.g. a server goes ready/failed).
    const offStatus = window.stem.onMcpStatus((s) => setStatuses(s));
    return () => {
      offChanged();
      offStatus();
    };
  }, []);

  // Servers pinned to a device that is no longer paired. They cannot run
  // anywhere, and they are the one case below that a window with a LOCAL server
  // still has to be able to fix — an orphan outlives the move that made it.
  const orphans = servers.filter((s) => s.location?.orphaned);
  const anyOrphan = orphans.length > 0;

  // The devices that could host a server: paired desktops only, because a phone
  // sleeps and a server on it would be unreachable half the time. Read only when
  // there is a choice to make — a window whose server is this very machine and
  // holds no orphan never renders a picker, so it never asks.
  useEffect(() => {
    if (!remote && !anyOrphan) return;
    void window.stem
      .listDevices()
      .then((snapshot) => setHosts(snapshot.devices.filter((d) => d.kind === 'desktop')))
      .catch(() => undefined);
  }, [remote, anyOrphan]);

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

  /**
   * Everything that has to catch up after mcp.json changed, in the order it has
   * to happen: the host on THIS computer first, then the bridge.
   *
   * Both, always, and not because every edit touches both. A pin is invisible in
   * the shape of an edit — adding a server pinned here, disabling one that runs
   * here, deleting one whose child is running here are, from this function's
   * side, an add, a toggle and a delete like any other. Asking only the bridge
   * would mean a server pinned to this machine sat there doing nothing (its
   * approval never offered) until the next launch, and a disabled or deleted one
   * kept its child alive over here just as long. The host answers from state it
   * already has, so the cost of asking when nothing changed is a function call.
   *
   * It covers this window and only this window, which is why it is not the
   * mechanism. The machine that runs a pinned server is usually NOT the one
   * whose panel is open — that is the entire point of pinning — and an edit can
   * arrive from a phone, a second desktop, or the assistant, none of which are
   * here. Telling the hosting machine is done at the writer instead
   * (writeServers in src/server/pi/mcp.ts); this stays because it makes the
   * window that made the edit correct immediately rather than a round-trip
   * later, and because the bridge still has to be restarted from somewhere.
   */
  async function applyMcpChange() {
    setHostState(await window.stem.refreshMcpHost().catch(() => hostState));
    await reconnect();
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
      await applyMcpChange();
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
    await applyMcpChange();
  }

  // Toggle a server on/off without removing it. Neither the bridge nor a hosting
  // machine re-reads mcp.json on its own, so both are told — see applyMcpChange.
  async function toggleEnabled(serverName: string, enabled: boolean) {
    setError(null);
    setServers(await window.stem.setMcpServerEnabled(serverName, enabled));
    await applyMcpChange();
  }

  /**
   * Move one server to another machine, or back to the one hosting the server.
   *
   * The list is replaced from the call's own answer, because the row now names a
   * different place; the two things that run the server catch up in
   * applyMcpChange, which is the same pair every other edit here needs.
   */
  async function moveTo(serverName: string, deviceId: string | null) {
    setError(null);
    try {
      setServers(await window.stem.setMcpServerLocation(serverName, deviceId));
      await applyMcpChange();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  /**
   * *Move to <device>*, for each machine that is not already this server's home.
   *
   * A machine whose name matches the one the pin remembered comes first and says
   * so. Pairing mints a new device id, so re-pairing the same Mac — the rollback
   * in running-on-a-server.md, an import, switching to this computer's server
   * and back — orphans everything pinned to it, and the fix is almost always
   * "the computer with the same name". It is offered, not applied: ⑩ refuses to
   * repoint a pin without somebody saying so, and a label is not evidence.
   */
  function moveButtons(s: McpServerSummary) {
    const remembered = s.location?.rememberedLabel;
    return hosts
      .filter((d) => d.id !== s.location?.deviceId)
      .slice()
      .sort((a, b) => Number(b.label === remembered) - Number(a.label === remembered))
      .map((d) => (
        <button key={d.id} className="link-btn" onClick={() => moveTo(s.name, d.id)} disabled={!!busy}>
          Move to {d.label}
          {d.id === thisDeviceId ? ' (this computer)' : ''}
          {remembered && d.label === remembered && d.id !== thisDeviceId ? ' (the same name as before)' : ''}
        </button>
      ));
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
   * How one server is doing — ONE ladder for every row, which is the point of it.
   *
   * A server pinned to a computer is the same kind of thing as one the Stem
   * server connects itself; the only difference between them is which machine
   * opens the connection. Giving the two different vocabularies — a dot here, a
   * pill there, and for a local command nothing at all — made that look like a
   * difference in kind, which it is not.
   *
   * The SOURCES differ, because they have to. This machine knows its own servers
   * first-hand; the bridge reports the ones it connects itself; and a server on
   * another of your computers is known second-hand, as `elsewhere` — carrying a
   * sentence when that machine has something wrong to report and none when it
   * has not. What comes out is the same handful of words either way.
   */
  function serverState(
    s: McpServerSummary
  ): 'connected' | 'pending' | 'failed' | 'needs-login' | 'needs-approval' | 'unknown' {
    if (!s.enabled) return 'unknown';
    const live = statuses[s.name]?.status;
    if (hostedHere(s)) {
      const mine = hostState.status[s.name]?.status;
      if (mine === 'unapproved') return 'needs-approval';
      if (mine === 'ready') return 'connected';
      if (mine === 'starting') return 'pending';
      return mine === 'failed' ? 'failed' : 'unknown';
    }
    if (s.location) {
      if (live !== 'elsewhere') return 'unknown';
      return statuses[s.name]?.error ? 'failed' : 'connected';
    }
    if (live === 'ready') return 'connected';
    if (live === 'starting') return 'pending';
    // A URL server that dropped is nearly always a token that expired, so it is
    // offered the way a signed-out one is: as something to press, not to read.
    if (live === 'failed') return s.transport === 'http' ? 'needs-login' : 'failed';
    if (s.transport === 'http') {
      // Nothing reported yet — the panel can open before any thread has started
      // this session. Credentials on disk are the best guess available.
      return s.authStatus === 'o_auth' || s.authStatus === 'bearer_token' ? 'connected' : 'needs-login';
    }
    return 'unknown';
  }

  /** What the dot says on hover — the one place a state names its machine. */
  function stateTitle(s: McpServerSummary, state: ReturnType<typeof serverState>): string {
    const where = hostedHere(s) ? 'this computer' : s.location ? s.location.label : 'your Stem server';
    const reported = statuses[s.name]?.error ?? hostState.status[s.name]?.error;
    if (state === 'failed') return reported ?? `It is not running on ${where}.`;
    if (state === 'pending') return `Starting on ${where}…`;
    return `Running on ${where}.`;
  }

  /**
   * The place, as its own line under the address — and only for a server that
   * is NOT where servers ordinarily are.
   *
   * It used to be a pill sitting beside the name, and it was wrong twice over.
   * A pill saying "Server" appeared on nearly every row, which is a label for
   * the default and therefore no information at all; and both it and the long
   * ones ("Vlado's MacBook") took their width out of the only column that
   * carries anything — in a 300px panel that broke names across three lines and
   * chopped commands mid-word. Naming just the exception costs one quiet line on
   * the few rows that are exceptional and gives every other row its width back.
   */
  function placeLabel(s: McpServerSummary): string | null {
    if (!s.location) return null;
    if (s.location.orphaned) {
      return s.location.rememberedLabel
        ? `Pinned to ${s.location.rememberedLabel}, which is no longer paired`
        : 'Pinned to a computer that is no longer paired';
    }
    return hostedHere(s) ? 'Runs on this computer' : `Runs on ${s.location.label}`;
  }

  function placeClass(s: McpServerSummary): string {
    // An orphaned pin is a real problem — the machine it names is gone — so it
    // reads as one rather than sitting quietly among the ordinary places.
    return `row-place${s.location?.orphaned ? ' orphaned' : ''}`;
  }

  function placeTitle(s: McpServerSummary): string {
    if (s.location?.orphaned) {
      const was = s.location.rememberedLabel ? ` It was pinned to “${s.location.rememberedLabel}”.` : '';
      return `This server is pinned to a device that is no longer paired, so it cannot run anywhere.${was}`;
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

  /** The ⓘ that opens a section's explanation, and stays pressed while it is open. */
  function explainToggle(key: string) {
    const open = !!explaining[key];
    return (
      <button
        className={`icon-btn explain${open ? ' on' : ''}`}
        aria-expanded={open}
        aria-label={open ? 'Hide explanation' : 'What does this mean?'}
        title={open ? 'Hide explanation' : 'What does this mean?'}
        onClick={() => setExplaining((prev) => ({ ...prev, [key]: !prev[key] }))}
      >
        <Info size={13} />
      </button>
    );
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

  /** The card's headline: a new spec, an edited one, or one that lost a secret. */
  function pendingHeading(p: McpHostPendingServer): string {
    if (p.lostSecrets?.length) return `${p.name} lost a saved credential`;
    return p.changed ? `${p.name} changed — approve it again` : `Approve ${p.name} to run here`;
  }

  /** What to say when a credential could not be read, or null when all were. */
  function lostLine(p: McpHostPendingServer): string | null {
    const keys = p.lostSecrets ?? [];
    if (keys.length === 0) return null;
    return (
      `Stem could not read the saved value of ${keys.join(', ')} on the computer holding the configuration — ` +
      'it was lost, not changed (usually an import opened with a different passphrase). That is why this is being ' +
      'asked again. Approving starts the server without it; set the value again in Settings → Tools first if it needs one.'
    );
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

  /**
   * Take somebody to the approval card for `name` and make it obvious they
   * arrived. The row's button deliberately does NOT approve: what the click
   * authorizes is a command line, its credentials and possibly an unbounded
   * shell, and that is on the card and nowhere else. A one-tap "Approve" beside
   * the name would be a yes to a question that was never shown.
   */
  function revealPending(name: string) {
    const card = document.getElementById(`mcp-pending-${name}`);
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashPending(name);
    window.setTimeout(() => setFlashPending((cur) => (cur === name ? null : cur)), 1600);
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

  /**
   * "Reconnect" when a token that worked has stopped working, "Sign in" when
   * there has never been one. Read from the live status rather than passed in,
   * now that both arrive at the button as the same state: they are the same
   * act, and the word is only there to say whether you have done it before.
   */
  function signInLabel(serverName: string): string {
    if (loginName === serverName) return 'Waiting…';
    return statuses[serverName]?.status === 'failed' ? 'Reconnect' : 'Sign in';
  }

  // The selected row, when it is a server-located entry there is somewhere to
  // move it to. Not offered on this-computer installs (⑨: one machine, so a
  // choice would imply a distinction that does not exist) and not on an already
  // pinned entry, which has its place and is that machine's business.
  const selectedServer = servers.find((s) => s.name === selected) ?? null;
  const movable = remote && hosts.length > 0 && selectedServer && !selectedServer.location ? selectedServer : null;
  // The pill in the row is what somebody notices; this is where the sentence
  // fits. Both, because the pill alone is a tooltip and a tooltip is not an
  // explanation on a machine with no mouse hovering over it.
  const signInLimited =
    selectedServer && selectedServer.location && selectedServer.transport === 'http' ? selectedServer : null;

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
        <div className="group mcp-list">
          {servers.map((s) => {
            const viaUrl = s.transport === 'http';
            const state = serverState(s);
            const detail = viaUrl ? s.url : `${s.command} ${s.args.join(' ')}`.trim();
            return (
              <div
                key={s.name}
                className={`group-row${selected === s.name ? ' selected' : ''}${s.enabled ? '' : ' disabled'}`}
                onClick={() => setSelected(s.name)}
              >
                <span className="row-main">
                  <strong title={s.name}>{s.name}</strong>
                  {/* The address, clamped to two lines with the whole of it on
                      the title — an npx invocation with four flags is longer
                      than any panel and is still the thing you came to read.
                      A failure takes the line instead, in the words of whichever
                      machine reported it, wherever that machine was. */}
                  <em
                    title={state === 'failed' ? stateTitle(s, state) : detail}
                    className={state === 'failed' ? 'mcp-failed' : undefined}
                  >
                    {state === 'failed' ? stateTitle(s, state) : detail}
                  </em>
                  {/* Where it runs — a line of its own, and only when that is
                      not the machine hosting the server. An entry that names a
                      computer says so wherever it is seen, including on a local
                      install, because a pin that outlived the move back is
                      exactly the one somebody needs to be told about. */}
                  {s.location && (
                    <span className={placeClass(s)} title={placeTitle(s)}>{placeLabel(s)}</span>
                  )}
                </span>
                {/* One slot, one vocabulary. A button when this machine is the
                    one being asked for something, a dot when it is not, and
                    nothing at all when there is nothing true to say. Disabled
                    has no badge: the switch is off and the row is dimmed, which
                    is the same fact said twice already. */}
                {state === 'needs-approval' ? (
                  <button
                    className="push"
                    title="This computer has not agreed to run it yet."
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(s.name);
                      revealPending(s.name);
                    }}
                  >
                    Approve…
                  </button>
                ) : state === 'needs-login' ? (
                  <button
                    className="push"
                    onClick={(e) => {
                      e.stopPropagation();
                      signIn(s.name);
                    }}
                    disabled={!!loginName || !!busy}
                  >
                    {signInLabel(s.name)}
                  </button>
                ) : state === 'connected' || state === 'pending' || state === 'failed' ? (
                  <span
                    className={`mcp-dot${state === 'pending' ? ' pending' : ''}${state === 'failed' ? ' failed' : ''}`}
                    title={stateTitle(s, state)}
                    aria-label={state === 'failed' ? 'Not running' : state === 'pending' ? 'Starting' : 'Running'}
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

      {/* An entry whose machine was unpaired (⑩). It was not deleted and it was
          not quietly repointed at the server, so this is where somebody decides
          which of those should happen — and it says what is wrong first, because
          "Unpaired device" in a pill is a symptom and not a sentence. */}
      {orphans.length > 0 && (
        <>
          <div className="grp-head">Pinned to a computer that is gone</div>
          <div className="formgroup">
            {orphans.map((s, i) => (
              <div key={s.name} className={`set-block${i === 0 ? '' : ' fg-divider'}`}>
                <span className="set-sub">
                  {s.name}
                  {s.location?.rememberedLabel ? ` — was “${s.location.rememberedLabel}”` : ''}
                </span>
                <p className="muted">
                  It runs nowhere: the computer it is pinned to is no longer paired.
                  {explainToggle(`orphan-${s.name}`)}
                </p>
                {explaining[`orphan-${s.name}`] && (
                  <p className="muted">
                    Nothing was deleted — pair that computer again, move the server to another one, or select
                    it above and remove it with −.
                    {s.location?.rememberedLabel
                      ? ' Pairing a computer again gives it a new identity, so the same machine under the same' +
                        ' name is a different device to Stem: if you have just re-paired it, it is the one' +
                        ' named below.'
                      : ''}
                  </p>
                )}
                <div className="memory-view-actions">
                  {moveButtons(s)}
                  <button className="link-btn" onClick={() => moveTo(s.name, null)} disabled={!!busy}>
                    {remote ? 'Run on the server instead' : 'Run on this computer instead'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* The everyday half of ⑩: an entry that works where it is, but whose work
          is on one of your own machines — its files, its applications, a URL its
          network can reach and the server's cannot. Offered on the selected row
          so the list stays a list. */}
      {movable && (
        <>
          <div className="grp-head">
            Move {movable.name}
            {explainToggle('move')}
          </div>
          <div className="formgroup">
            <div className="set-block">
              <div className="memory-view-actions">{moveButtons(movable)}</div>
              {explaining.move && (
                <p className="muted">
                  It runs on the machine hosting your Stem server. Move it to one of your own computers and
                  it runs there instead, reaching that computer’s files, its applications and its network.
                  Whoever is at that computer approves it there before it starts — an approval belongs to the
                  machine that gave it, so a move never carries one across.
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {signInLimited && (
        <>
          <div className="grp-head">
            Signing in to {signInLimited.name}
            {explainToggle('oauth')}
          </div>
          <div className="formgroup">
            <div className="set-block">
              <span className="set-sub">Static token only</span>
              {explaining.oauth && <p className="muted">{NO_OAUTH_ELSEWHERE}</p>}
            </div>
          </div>
        </>
      )}

      {/* The server is older than this app and does not know what a pinned
          server is. Said here because the alternative is a panel that looks
          exactly like one with nothing pinned to this computer. */}
      {hostState.unsupported && <p className="error">{hostState.unsupported}</p>}

      {/* One card per spec this computer has been asked to run and has not
          agreed to. It waits here rather than interrupting at launch (⑥): a
          modal on startup would be answered by whoever wanted it to go away. */}
      {hostState.pending.map((p) => (
        <div key={p.name} id={`mcp-pending-${p.name}`}>
          <div className="grp-head">{pendingHeading(p)}</div>
          <div className={`formgroup${flashPending === p.name ? ' flash' : ''}`}>
            <div className="set-block">
              <span className="set-sub">This computer would run</span>
              <code>{previewLine(p.preview)}</code>
              {credentialLine(p.preview) && <p className="muted">{credentialLine(p.preview)}</p>}
              {/* A lost credential and an edited one both move the fingerprint,
                  and only one of them is somebody's doing. Saying "changed" to
                  the second is true and useless: nobody changed it, and
                  approving anyway starts a server without its key. */}
              {lostLine(p) ? (
                <p className="error">{lostLine(p)}</p>
              ) : (
                <p className="muted">
                  {p.changed
                    ? 'Its command, arguments or credentials are not the ones you approved. Stem stopped it and will not start it again until you say so.'
                    : 'Stem never starts a server on your own computer without being asked, even when the entry was added elsewhere.'}
                </p>
              )}
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
