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
  // Any pin at all, sound or broken. A local install can hold one — an import,
  // or a pin that outlived the move back — and its owner must be able to undo it
  // without standing up a server again, so the device list is worth asking for.
  const anyPinned = servers.some((s) => s.location);

  // The devices that could host a server: paired desktops only, because a phone
  // sleeps and a server on it would be unreachable half the time. Read only when
  // there is a choice to make — a window whose server is this very machine and
  // holds nothing pinned never renders a picker, so it never asks.
  useEffect(() => {
    if (!remote && !anyPinned) return;
    void window.stem
      .listDevices()
      .then((snapshot) => setHosts(snapshot.devices.filter((d) => d.kind === 'desktop')))
      .catch(() => undefined);
  }, [remote, anyPinned]);

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
   * The list, cut into one section per machine.
   *
   * Where a server runs stopped being something written on its row and became
   * WHERE THE ROW SITS. Every version that put the place on the row bought its
   * visibility with width or a third line — a pill beside the name broke a
   * 300px panel's names across three lines, and a line under the address was so
   * quiet it read as a footnote to the command. A section header costs the row
   * neither, and it answers a question the flat list could not answer at all:
   * what does this machine run? It is also the honest shape of the thing —
   * these servers really do belong to machines, and a machine can be asleep,
   * unpaired or gone as a whole.
   *
   * Headers appear only when there is more than one place to name. With nothing
   * pinned anywhere the list has one section, and a header that appears once
   * distinguishes nothing, so it says "MCP servers" and stops.
   */
  function placeGroups(): { key: string; head: string; items: McpServerSummary[] }[] {
    if (!anyPinned) return [{ key: 'all', head: 'MCP servers', items: servers }];

    const groups: { key: string; head: string; items: McpServerSummary[] }[] = [];
    const add = (key: string, head: string, items: McpServerSummary[]) => {
      if (items.length > 0) groups.push({ key, head, items });
    };
    const unpinned = servers.filter((s) => !s.location);
    const here = servers.filter((s) => hostedHere(s));

    // On a local install the machine hosting the server IS this computer, so an
    // unpinned server and one pinned here are the same answer to "where does it
    // run" — two sections with identical headers would be a distinction only the
    // config file cares about.
    if (remote) {
      add('server', 'On your Stem server', unpinned);
      add('here', 'On this computer', here);
    } else {
      add('here', 'On this computer', [...unpinned, ...here]);
    }

    // One section per other machine, by device rather than by label: two paired
    // computers may honestly share a name, and merging them would claim a server
    // runs somewhere it does not.
    const others = new Map<string, { key: string; head: string; items: McpServerSummary[] }>();
    for (const s of servers) {
      if (!s.location || s.location.orphaned || hostedHere(s)) continue;
      const group = others.get(s.location.deviceId) ?? {
        key: `dev-${s.location.deviceId}`,
        head: `On ${s.location.label}`,
        items: []
      };
      group.items.push(s);
      others.set(s.location.deviceId, group);
    }
    groups.push(...[...others.values()].sort((a, b) => a.head.localeCompare(b.head)));

    // Last, and named for the consequence rather than the cause: what matters
    // about a pin to an unpaired computer is that the server runs nowhere.
    add('orphan', 'Nowhere — that computer is gone', orphans);
    return groups;
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

  /**
   * The approval this computer owes a server pinned to it (⑥), inline under its
   * row. It used to be a card at the bottom of the panel that the row pointed at
   * from a distance — and the pointing is exactly what broke: the jump landed
   * silently, and even fixed it asked somebody to read a row here and answer a
   * question there. A question belongs under the thing it is about.
   *
   * It is shown without being asked for, unlike everything else in a row's
   * detail. This one is not information about a server, it is a server waiting
   * on a person, and a call to action that only appears once you click the right
   * row is one most people never see.
   */
  function approvalCard(p: McpHostPendingServer) {
    return (
      <>
        <span className="set-sub">{pendingHeading(p)}</span>
        <code>{previewLine(p.preview)}</code>
        {credentialLine(p.preview) && <p className="muted">{credentialLine(p.preview)}</p>}
        {/* A lost credential and an edited one both move the fingerprint, and
            only one of them is somebody's doing. Saying "changed" to the second
            is true and useless: nobody changed it, and approving anyway starts a
            server without its key. */}
        {lostLine(p) && <p className="error">{lostLine(p)}</p>}
        {!lostLine(p) && p.changed && (
          <p className="muted">
            Its command, arguments or credentials are not the ones you approved. Stem stopped it and will not
            start it again until you say so.
          </p>
        )}
        {/* The one thing the plan insists is visible rather than documented:
            after this click there are no further questions, so what the click
            authorizes has to be readable here. Why it is being asked at all,
            when nothing is wrong, is the part that goes behind the ⓘ — this
            strip sits in the middle of a list and cannot be an essay. */}
        <p className="muted">
          Once approved, Stem starts it and uses its tools whenever the assistant asks — including on a scheduled
          run — without asking again.
          {!p.changed && !lostLine(p) && explainToggle(`why-${p.name}`)}
        </p>
        {explaining[`why-${p.name}`] && (
          <p className="muted">
            Stem never starts a server on your own computer without being asked, even when the entry was added
            elsewhere — from your phone, from another computer, or by the assistant.
          </p>
        )}
        {p.unbounded && <p className="error">{p.unbounded}</p>}
        <div className="memory-view-actions">
          <button className="link-btn" onClick={() => approveHosted(p)}>
            Approve and start
          </button>
        </div>
      </>
    );
  }

  /**
   * Everything there is to do to one server, under that server.
   *
   * These were five sections stacked below the list — approve, on this computer,
   * move, signing in, pinned to a computer that is gone — each repeating a name
   * from the list and each about exactly one row. With the list grouped by
   * machine they also started repeating its headers. One detail strip under the
   * selected row says the same things in the one place where you do not have to
   * carry a name down the panel to use them.
   */
  function rowDetail(s: McpServerSummary) {
    const pending =
      hostedHere(s) && hostState.status[s.name]?.status === 'unapproved'
        ? hostState.pending.find((p) => p.name === s.name)
        : undefined;
    if (pending) {
      return <div className="row-detail approval">{approvalCard(pending)}</div>;
    }
    if (selected !== s.name) return null;

    // Moving is offered wherever there is somewhere else to go, an orphan
    // included — a pin you cannot undo from the panel that made it is a trap,
    // and the machine list is only fetched when there is a choice to make.
    const elsewhere = moveButtons(s);
    const canUnpin = !!s.location && (remote || !s.location.orphaned || hosts.length > 0);
    const bits: React.ReactNode[] = [];

    if (s.location?.orphaned) {
      bits.push(
        <p className="muted" key="orphan">
          It runs nowhere: the computer it is pinned to is no longer paired.
          {explainToggle(`orphan-${s.name}`)}
        </p>
      );
      if (explaining[`orphan-${s.name}`]) {
        bits.push(
          <p className="muted" key="orphan-why">
            Nothing was deleted — pair that computer again, move it to another one, or remove it with −.
            {s.location.rememberedLabel
              ? ' Pairing a computer again gives it a new identity, so the same machine under the same name is a' +
                ' different device to Stem: if you have just re-paired it, it is the one offered below.'
              : ''}
          </p>
        );
      }
    } else if (hostedHere(s)) {
      bits.push(
        <p className="muted" key="state">
          {hostStateLine(hostState.status[s.name])}
        </p>
      );
      bits.push(
        <div className="memory-view-actions" key="host-actions">
          <button className="link-btn" onClick={() => testHosted(s.name)} disabled={testing === s.name}>
            {testing === s.name ? 'Connecting…' : 'Test connection'}
          </button>
          {hostState.approved[s.name] && (
            <button className="link-btn danger" onClick={() => rejectHosted(s.name)}>
              Stop trusting
            </button>
          )}
        </div>
      );
    } else if (s.location) {
      // Another of your computers owns it. This window has nothing true to say
      // about whether it is approved or running there — only where to send it.
      bits.push(
        <p className="muted" key="elsewhere">
          {`“${s.location.label}” runs it and decides whether it runs: there is nothing to approve or test from here.`}
        </p>
      );
    }

    // OAuth cannot run for a pinned URL server, and the sentence has to be
    // somewhere a person without a mouse can read it (⑤).
    if (s.location && s.transport === 'http' && !s.location.orphaned) {
      bits.push(
        <p className="muted" key="oauth">
          Static token only
          {explainToggle(`oauth-${s.name}`)}
        </p>
      );
      if (explaining[`oauth-${s.name}`]) {
        bits.push(
          <p className="muted" key="oauth-why">
            {NO_OAUTH_ELSEWHERE}
          </p>
        );
      }
    }

    if (elsewhere.length > 0 || canUnpin) {
      bits.push(
        <div className="memory-view-actions" key="move">
          {elsewhere}
          {canUnpin && (
            <button className="link-btn" onClick={() => moveTo(s.name, null)} disabled={!!busy}>
              {remote ? 'Run on the server instead' : 'Run on this computer instead'}
            </button>
          )}
          {explainToggle(`move-${s.name}`)}
        </div>
      );
      if (explaining[`move-${s.name}`]) {
        bits.push(
          <p className="muted" key="move-why">
            A server runs on one machine and reaches that machine’s files, its applications and its network.
            Whoever is at that computer approves it there before it starts — an approval belongs to the machine
            that gave it, so a move never carries one across.
          </p>
        );
      }
    }

    if (bits.length === 0) return null;
    return <div className="row-detail selected">{bits}</div>;
  }

  const groups = placeGroups();

  return (
    <div>
      {servers.length === 0 ? (
        <>
          <div className="grp-head">MCP servers</div>
          <div className="group">
            <div className="group-row">
              <span className="row-main">
                <em>No servers yet. Add one with the + button.</em>
              </span>
            </div>
          </div>
        </>
      ) : (
        groups.map((group) => (
          <div key={group.key}>
            <div className="grp-head">{group.head}</div>
            <div className="group mcp-list">
              {group.items.map((s) => {
                const viaUrl = s.transport === 'http';
                const state = serverState(s);
                const detail = viaUrl ? s.url : `${s.command} ${s.args.join(' ')}`.trim();
                return (
                  <div key={s.name} className="row-block">
                    <div
                      className={`group-row${selected === s.name ? ' selected' : ''}${s.enabled ? '' : ' disabled'}`}
                      onClick={() => setSelected(selected === s.name ? null : s.name)}
                    >
                      <span className="row-main">
                        <strong title={s.name}>{s.name}</strong>
                        {/* The address, clamped to two lines with the whole of it
                            on the title — an npx invocation with four flags is
                            longer than any panel and is still the thing you came
                            to read. A failure takes the line instead, in the
                            words of whichever machine reported it. */}
                        <em
                          title={state === 'failed' ? stateTitle(s, state) : detail}
                          className={state === 'failed' ? 'mcp-failed' : undefined}
                        >
                          {state === 'failed' ? stateTitle(s, state) : detail}
                        </em>
                      </span>
                      {/* One slot, one vocabulary. A dot when the row is being
                          told something, a Sign in button when this machine is
                          being asked for something, and nothing at all when
                          there is nothing true to say. An unapproved server has
                          no button here either: its question is open under the
                          row, which is a better answer than a button pointing at
                          one. */}
                      {state === 'needs-login' ? (
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
                          aria-label={
                            state === 'failed' ? 'Not running' : state === 'pending' ? 'Starting' : 'Running'
                          }
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
                    {rowDetail(s)}
                  </div>
                );
              })}
            </div>
          </div>
        ))
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

      {/* The server is older than this app and does not know what a pinned
          server is. Said here because the alternative is a panel that looks
          exactly like one with nothing pinned to this computer. */}
      {hostState.unsupported && <p className="error">{hostState.unsupported}</p>}

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
