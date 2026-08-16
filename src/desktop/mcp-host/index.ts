import { log } from '../../server/log';
import { connectClient, type McpClient, type McpToolDefinition } from './clients';
import { fileApprovalStore, type ApprovalStore } from './approvals';
import type {
  DeviceMcpAnnouncement,
  DeviceMcpAssignment,
  DeviceMcpRequest,
  DeviceMcpResult,
  DeviceMcpServerReport,
  DeviceMcpSpec,
  DeviceMcpTool,
  McpHostLocalState,
  McpHostPendingServer,
  McpHostServerStatus,
  McpHostSpecPreview
} from '../../shared/types';

// This machine's half of an MCP server pinned to it (docs/mcp-device-pinning.md).
//
// The server holds the spec; this holds the decision to run it, the process it
// spawns, and the answer to one call. The split is decision ④: mcp.json is
// central, so a compromised server can put any command it likes in there — and
// gets nowhere, because the yes lives on the computer the command would run on.
//
// What this file guarantees, in the order the plan asks for it:
//
//  - **Eager start** (⑥). Everything already approved connects at launch,
//    without being asked twice, because that is what a local Stem has always
//    done: main.ts prewarms pi, and pi connects every configured server. Moving
//    a server onto your Mac must not make it something you have to switch on.
//  - **Never an unapproved spawn, and never a modal.** An unapproved or changed
//    spec is not started, not "started to see if it works", and not surfaced as
//    an interruption. It waits in the Manage panel until somebody sitting at
//    this machine says yes. `test()` is deliberately included in that rule.
//  - **A call always gets an answer.** Every path through onRequest() ends in an
//    `mcpHost:result`, including the ones where the server does not exist here
//    or refuses to run — the alternative is the far end waiting out a two-minute
//    timeout for a machine that was awake and listening the whole time.
//
// The transport, the correlation ids and the timeouts all belong to the router
// on the other side (src/server/mcp-device/router.ts). Nothing here retries,
// queues or remembers a call.

/** One server this machine has been asked to host, and how it is doing. */
interface Hosted {
  name: string;
  spec: DeviceMcpSpec;
  fingerprint: string;
  status: McpHostServerStatus['status'];
  error?: string;
  tools: McpToolDefinition[];
  /** The live connection, or null when there is nothing running. */
  client: McpClient | null;
}

export interface McpHostDeps {
  /**
   * How to speak to the server — `proxy.invoke`. Late-bound by the caller
   * because the proxy is constructed with this host as one of its dependencies,
   * and one of the two has to be able to wait for the other.
   */
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /** Where this machine's approvals live. Injected so a test never writes a file. */
  approvals?: ApprovalStore;
  /** How a spec becomes a connection. Injected so a test never spawns a process. */
  connect?(name: string, spec: DeviceMcpSpec): McpClient;
  /** Called whenever the panel's view of this machine would change. */
  changed?(state: McpHostLocalState): void;
}

export interface McpHost {
  /** Ask what this machine hosts and start what it has already agreed to (⑥). */
  start(): Promise<void>;
  /** Ask again and reconcile — after a reconnection, or on the user's request. */
  refresh(): Promise<void>;
  /** Answer one addressed request. Never throws; always replies. */
  onRequest(request: DeviceMcpRequest): void;
  /** Everything the panel needs about the servers hosted here. */
  localState(): McpHostLocalState;
  /** Agree to run `name`'s current spec, and start it. */
  approve(name: string, fingerprint: string): Promise<McpHostLocalState>;
  /** Withdraw agreement to run `name`, and stop it. */
  reject(name: string): Promise<McpHostLocalState>;
  /** Connect now and report what actually happened. Approval still applies. */
  test(name: string): Promise<McpHostLocalState>;
  /** Stop every child. Called when the app quits. */
  close(): void;
}

export function createMcpHost(deps: McpHostDeps): McpHost {
  const approvals = deps.approvals ?? fileApprovalStore();
  const connect = deps.connect ?? connectClient;

  /** Every server pinned to this machine, by name. */
  const servers = new Map<string, Hosted>();
  /** The approval store's contents, cached so localState() can stay synchronous. */
  let approved: Record<string, string> = {};
  /** Handshakes in progress — what an announcement waits for (see announceSoon). */
  const connecting = new Set<Promise<void>>();
  let announceQueued = false;
  let closed = false;

  // ---- state ----

  function localState(): McpHostLocalState {
    const status: Record<string, McpHostServerStatus> = {};
    const pending: McpHostPendingServer[] = [];
    for (const entry of servers.values()) {
      status[entry.name] = {
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.status === 'ready' ? { tools: entry.tools.length } : {})
      };
      if (entry.status !== 'unapproved') continue;
      const unbounded = unboundedSurface(entry.name, entry.spec);
      pending.push({
        name: entry.name,
        fingerprint: entry.fingerprint,
        preview: previewOf(entry.spec),
        // "Changed" and "new" are answered differently by somebody who knows
        // they did not edit it, so the card must be able to tell them apart.
        changed: !!approved[entry.name] && approved[entry.name] !== entry.fingerprint,
        ...(unbounded ? { unbounded } : {})
      });
    }
    return { approved: { ...approved }, pending, status };
  }

  /** Tell the window, and tell the server. Called after every state change. */
  function publish(): void {
    deps.changed?.(localState());
    announceSoon();
  }

  /**
   * Report this machine's catalog upward, once nothing is still connecting.
   *
   * The wait is what keeps ③ honest. A report written while three servers were
   * mid-handshake would say this device hosts fewer tools than it does, and the
   * assistant would act on that for as long as it stood — whereas the catalog on
   * the server holds the PREVIOUS announcement until this one lands, which is a
   * better answer than a fresh wrong one. Everything that connects has its own
   * timeout, so the wait is bounded by that and not by a hung server.
   */
  function announceSoon(): void {
    if (announceQueued || closed) return;
    announceQueued = true;
    void (async () => {
      while (connecting.size > 0) await Promise.allSettled([...connecting]);
      announceQueued = false;
      if (closed) return;
      try {
        await deps.invoke('mcpHost:announce', [announcement()]);
      } catch (e) {
        // The server is unreachable, which is a thing that happens and not an
        // error here: the next launch says hello again and re-announces.
        log('mcp-host', 'could not announce the MCP catalog', { error: errorText(e) });
      }
    })();
  }

  function announcement(): DeviceMcpAnnouncement {
    return {
      servers: [...servers.values()].map(
        (entry): DeviceMcpServerReport => ({
          name: entry.name,
          // Announcements happen with nothing in flight, so 'starting' should
          // never reach here — and if it somehow does, the assistant must not be
          // told a server is ready that has not said so.
          status: entry.status === 'starting' ? 'failed' : entry.status,
          ...(entry.status === 'starting' ? { error: 'Never finished connecting.' } : {}),
          ...(entry.error ? { error: entry.error } : {}),
          fingerprint: entry.fingerprint,
          ...(entry.tools.length > 0 ? { tools: entry.tools.map(summarizeTool) } : {})
        })
      )
    };
  }

  // ---- connecting ----

  /**
   * Start one server and record what happened. The caller has already decided
   * this spec is approved; this function does not check again, so there is
   * exactly one place that does (see sync/approve).
   */
  function start(entry: Hosted): Promise<void> {
    stopClient(entry);
    if (closed) return Promise.resolve();
    const client = connect(entry.name, entry.spec);
    entry.client = client;
    entry.status = 'starting';
    entry.error = undefined;
    entry.tools = [];
    const job = (async () => {
      let tools: McpToolDefinition[] = [];
      let failure: string | null = null;
      try {
        // start() and handshake() are one try for one reason: an unspawnable
        // binary can fail either synchronously (a command that is not a string
        // a kernel will take) or asynchronously (ENOENT, which arrives as an
        // 'error' event the client turns into a rejection). Both are this
        // server failing, and neither is Stem failing.
        client.start();
        tools = await client.handshake();
      } catch (e) {
        failure = errorText(e);
      }
      // Superseded while we were handshaking — a re-sync, a reject, a second
      // Test. This child belongs to nobody now and must not be left running.
      if (entry.client !== client) {
        client.stop();
        return;
      }
      if (failure) {
        client.stop();
        entry.client = null;
        entry.status = 'failed';
        entry.error = failure;
        log('mcp-host', 'an MCP server pinned here could not start', { name: entry.name, error: failure });
      } else {
        entry.tools = tools;
        entry.status = 'ready';
        log('mcp-host', 'started an MCP server pinned to this machine', {
          name: entry.name,
          tools: tools.length
        });
      }
      publish();
    })();
    connecting.add(job);
    void job.finally(() => connecting.delete(job));
    publish();
    return job;
  }

  function stopClient(entry: Hosted): void {
    try {
      entry.client?.stop();
    } catch {
      // best-effort; a client that throws on teardown is already gone
    }
    entry.client = null;
  }

  /**
   * Ask the server which servers are ours and make the running set match.
   *
   * This is the whole approval gate. A spec whose fingerprint is not the one
   * this machine approved gets an entry, a place in the panel and no process —
   * which covers both halves of ④ at once: a server that was never approved,
   * and one whose `args` or `env` were edited since it was.
   */
  async function sync(): Promise<void> {
    if (closed) return;
    let assignments: DeviceMcpAssignment[];
    try {
      const answer = await deps.invoke('mcpHost:hello', []);
      assignments = Array.isArray(answer) ? (answer as DeviceMcpAssignment[]) : [];
    } catch (e) {
      // An unreachable server, or one too old to know the channel. Neither is a
      // reason to tear down servers that are running perfectly well here.
      log('mcp-host', 'could not ask the server what this machine hosts', { error: errorText(e) });
      return;
    }
    approved = await approvals.read();

    const wanted = new Set(assignments.map((a) => a.name));
    for (const [name, entry] of servers) {
      if (wanted.has(name)) continue;
      // Un-pinned, disabled or deleted on the server. Stop it here rather than
      // leaving an orphaned child holding this machine's files open.
      stopClient(entry);
      servers.delete(name);
      log('mcp-host', 'stopped an MCP server this machine no longer hosts', { name });
    }

    for (const assignment of assignments) {
      const existing = servers.get(assignment.name);
      const isApproved = approved[assignment.name] === assignment.fingerprint;
      if (existing && existing.fingerprint === assignment.fingerprint) {
        // Same spec as last time. Leave a working connection alone — a re-sync
        // must not cost every server a fresh handshake — and only move it when
        // the answer to "may this run" has changed since.
        if (isApproved && existing.status === 'unapproved') void start(existing);
        else if (!isApproved && existing.status !== 'unapproved') {
          stopClient(existing);
          existing.status = 'unapproved';
          existing.error = undefined;
          existing.tools = [];
        } else if (existing.status === 'ready' && existing.client?.alive === false) {
          // The child died on its own. Say so rather than routing a call into a
          // pipe nobody is reading; Test connection is how it comes back.
          existing.status = 'failed';
          existing.error = `${existing.name} is no longer running.`;
          existing.client = null;
        }
        continue;
      }
      if (existing) stopClient(existing);
      const entry: Hosted = {
        name: assignment.name,
        spec: assignment.spec,
        fingerprint: assignment.fingerprint,
        status: 'unapproved',
        tools: [],
        client: null
      };
      servers.set(entry.name, entry);
      if (isApproved) void start(entry);
    }
    publish();
  }

  // ---- answering one call ----

  /**
   * Why a request cannot be served, or null when it can. Written for a person:
   * these strings travel back to the assistant, which repeats them to whoever
   * asked, who is quite possibly not sitting at this computer.
   */
  function unavailable(entry: Hosted | undefined, server: string): string | null {
    if (!entry) {
      return `This computer is not hosting an MCP server called “${server}”.`;
    }
    if (entry.status === 'unapproved') {
      return (
        `“${server}” has not been approved on the computer it runs on. ` +
        'Open Stem there, go to Manage → MCP servers, and approve it — Stem never starts a server on your own machine without being asked.'
      );
    }
    if (entry.status === 'starting') return `“${server}” is still starting on the computer that hosts it.`;
    if (entry.status === 'failed' || !entry.client) {
      return `“${server}” could not start on the computer that hosts it: ${entry.error ?? 'no reason given'}`;
    }
    return null;
  }

  async function answer(request: DeviceMcpRequest): Promise<DeviceMcpResult> {
    const entry = servers.get(request.server);
    const refusal = unavailable(entry, request.server);
    if (refusal || !entry?.client) return { ok: false, error: refusal ?? 'unavailable' };

    if (request.op === 'tools') {
      return { ok: true, tools: entry.tools.map(summarizeTool) };
    }

    const tool = entry.tools.find((t) => t.name === request.tool);
    if (!tool) return { ok: false, error: `“${request.server}” has no tool “${request.tool}”.` };
    try {
      const result = await entry.client.callTool(tool.name, request.args ?? {});
      // MCP content arrays pass through as they are; anything else is wrapped,
      // so the far end always receives the same shape and never has to guess
      // whether a server answered in the protocol's own vocabulary.
      const content = (result as { content?: unknown } | null)?.content;
      return {
        ok: true,
        content: Array.isArray(content) ? content : [{ type: 'text', text: JSON.stringify(result ?? null) }]
      };
    } catch (e) {
      // A call that fails because the child died leaves the entry honest, so the
      // next request is refused with a sentence instead of hanging.
      if (entry.client?.alive === false) {
        stopClient(entry);
        entry.status = 'failed';
        entry.error = `${entry.name} is no longer running.`;
        publish();
      }
      return { ok: false, error: errorText(e) };
    }
  }

  function onRequest(request: DeviceMcpRequest): void {
    void answer(request)
      .catch((e): DeviceMcpResult => ({ ok: false, error: errorText(e) }))
      .then((result) => deps.invoke('mcpHost:result', [request.requestId, result]))
      .catch((e) => log('mcp-host', 'could not answer an MCP request', { error: errorText(e) }));
  }

  // ---- the panel's three channels ----

  return {
    start: sync,
    refresh: sync,
    onRequest,
    localState,

    async approve(name, fingerprint) {
      const entry = servers.get(name);
      if (!entry) {
        throw new Error(`This computer is not being asked to host an MCP server called “${name}”.`);
      }
      // The window sends back the fingerprint it drew the card from. If the spec
      // moved in between — the assistant edited it, another window changed it —
      // the approval would be for something nobody read, so it is refused and
      // the fresh card is what gets answered instead.
      if (entry.fingerprint !== fingerprint) {
        throw new Error(
          `The configuration for “${name}” changed while you were looking at it. Check what it runs now before approving.`
        );
      }
      await approvals.approve(name, fingerprint);
      approved = { ...approved, [name]: fingerprint };
      await start(entry);
      return localState();
    },

    async reject(name) {
      await approvals.reject(name);
      approved = { ...approved };
      delete approved[name];
      const entry = servers.get(name);
      if (entry) {
        stopClient(entry);
        entry.status = 'unapproved';
        entry.error = undefined;
        entry.tools = [];
        publish();
      }
      return localState();
    },

    async test(name) {
      // Re-ask first: the most common reason to press this is that the spec was
      // just edited on the server, and testing the copy we started with would
      // answer a question nobody asked.
      await sync();
      const entry = servers.get(name);
      // An unapproved spec is not connected, not even to diagnose it. That would
      // be exactly the spawn ④ exists to require a decision for, spent by
      // pressing a button labelled "Test connection" — the card is what you meet
      // here instead (⑥).
      if (entry && entry.status !== 'unapproved' && entry.status !== 'starting') await start(entry);
      // Wait for whatever sync() itself kicked off, so the state handed back has
      // the real error in it rather than a row that still says "starting".
      while (connecting.size > 0) await Promise.allSettled([...connecting]);
      return localState();
    },

    close() {
      closed = true;
      for (const entry of servers.values()) stopClient(entry);
      servers.clear();
    }
  };
}

// ---- reading a spec ----

/**
 * What approving this would run, without the credentials it would run with.
 * See McpHostSpecPreview: the values stop in this process, the names travel.
 */
export function previewOf(spec: DeviceMcpSpec): McpHostSpecPreview {
  return {
    ...(spec.command?.trim() ? { command: spec.command } : {}),
    ...(spec.args?.length ? { args: [...spec.args] } : {}),
    ...(spec.url?.trim() ? { url: spec.url } : {}),
    ...(spec.env && Object.keys(spec.env).length ? { envKeys: Object.keys(spec.env).sort() } : {}),
    ...(spec.headers && Object.keys(spec.headers).length
      ? { headerKeys: Object.keys(spec.headers).sort() }
      : {})
  };
}

/**
 * Shells: a server whose command is one of these does not have a tool set, it
 * has a way to run programs, whatever follows on the command line.
 */
const SHELLS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  'cmd', 'powershell', 'pwsh',
  'osascript', 'applescript'
]);

/**
 * Language runtimes, which are a different case and must not be treated as the
 * one above. `node /opt/some-server.js` is how a great many perfectly ordinary
 * MCP servers are started — stem-recall is one — and flagging every one of them
 * would fire this warning on almost every stdio server anybody adds. A warning
 * that appears every time is a warning nobody reads by the third time, which
 * would cost exactly the case it exists for.
 *
 * What makes a runtime unbounded is being handed no program: bare, or with code
 * on the command line. Then there is no script to be bounded BY.
 */
const RUNTIMES = new Set(['python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php']);

/** Flags that hand a runtime its program as text rather than as a file. */
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '--eval-script', '-p', '--print', '--command']);

/** Words that name the thing itself, wherever they appear in a spec. */
const UNBOUNDED_WORDS = /(^|[^a-z])(shell|exec|terminal|commander|ssh)([^a-z]|$)/i;

/**
 * Whether approving this authorizes unbounded execution, and the sentence to say
 * so with — or null when the server looks like an ordinary bounded one.
 *
 * This exists because of the one risk the plan accepts knowingly. ⑤ removed
 * per-call confirmation on the argument that an MCP server's surface is fixed at
 * approval time; for a shell server that argument is simply false, and the whole
 * protection then sits in what somebody understood themselves to be approving.
 * So it has to be on the card, not in a document.
 *
 * It errs toward saying something. A false positive costs one extra sentence on
 * a card somebody is already reading carefully; a false negative costs the only
 * warning there was going to be.
 */
export function unboundedSurface(name: string, spec: DeviceMcpSpec): string | null {
  const command = spec.command?.trim() ?? '';
  const args = spec.args ?? [];
  if (command) {
    const base = command.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
    // A runtime pointed at a script is bounded by that script; the same runtime
    // with nothing to run, or with the program written out as an argument, is
    // not. `-Command` is PowerShell's, and PowerShell is a shell anyway — it is
    // in the list for the runtimes that borrow the spelling.
    const inlineCode = args.some((arg) => INLINE_CODE_FLAGS.has(arg.trim().toLowerCase()));
    if (SHELLS.has(base) || (RUNTIMES.has(base) && (args.length === 0 || inlineCode))) {
      return (
        `This one starts ${base}, which can run anything on this computer. Approving it is not approving a fixed set of tools — ` +
        'it is approving whatever the assistant later asks it to run, without another question.'
      );
    }
  }
  const words = [name, command, ...args, spec.url ?? ''].join(' ');
  if (UNBOUNDED_WORDS.test(words)) {
    return (
      'This looks like a server that runs commands on your behalf. If it is, approving it authorizes anything it can be asked ' +
      'to run on this computer, not a fixed set of tools — Stem will not ask again for each call.'
    );
  }
  return null;
}

// ---- rendering a tool for the catalog ----

/**
 * One tool as the catalog block needs it: a name, a first sentence and a compact
 * argument list. The full JSON schema stays here and is fetched on demand, which
 * is the same bargain the bridge's own catalog makes — a few servers' worth of
 * input schemas is tens of thousands of tokens in every prompt.
 */
function summarizeTool(tool: McpToolDefinition): DeviceMcpTool {
  const description = oneLine(tool.description);
  return {
    name: tool.name,
    ...(description ? { description } : {}),
    signature: compactSignature(tool.inputSchema)
  };
}

/** First sentence (or ~120 chars) of a description, collapsed to one line. */
function oneLine(description: string | undefined): string {
  if (!description) return '';
  const flat = description.replace(/\s+/g, ' ').trim();
  const stop = flat.indexOf('. ');
  const s = stop > 0 && stop < 120 ? flat.slice(0, stop + 1) : flat;
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** Compact "(req, opt?)" signature from a JSON-Schema object, required first. */
function compactSignature(schema: McpToolDefinition['inputSchema']): string {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return '()';
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const keys = Object.keys(properties);
  if (keys.length === 0) return '()';
  const ordered = [...keys.filter((k) => required.has(k)), ...keys.filter((k) => !required.has(k)).map((k) => `${k}?`)];
  const shown = ordered.slice(0, 8);
  return `(${shown.join(', ')}${ordered.length > shown.length ? ', …' : ''})`;
}

/** An error as a sentence, whatever it actually was. */
function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.trim() || 'an unknown error';
}
