import { spawn, type ChildProcess } from 'node:child_process';
import type { DeviceMcpSpec } from '../../shared/types';

// Two minimal MCP clients: a stdio one that spawns a child here, and a
// Streamable-HTTP one that opens a URL from THIS machine's network. Together
// they are the whole of decision ① — one host covering both, because "where it
// runs" is perpendicular to "how you reach it".
//
// ---- These are a second copy, deliberately ----
//
// src/server/pi/stem-mcp-extension.mjs has the originals, and they stay there.
// That file is not a module this process can import: it is dependency-free ESM
// loaded by `pi -e` INSIDE the pi child process, which may be running on another
// computer entirely — that is the whole premise of a device-located server. It
// also carries a lot this side must not have (Stem's secret-at-rest twins, the
// OAuth token file, the protected-roots gate), all of it about the server's own
// disk.
//
// So the two copies exist because the two ends are two programs. What is copied
// is small, finished and slow-moving: the JSON-RPC framing and the handshake,
// which are the MCP specification and not Stem's choices. If you change one for
// a reason that is about the PROTOCOL, change both. If you change one for a
// reason that is about where it runs, you are in the right file already.
//
// The behaviour that must survive the copy, because each line of it was paid for
// by a real failure:
//
//  - a child that cannot spawn emits 'error', which is fatal to the process when
//    unhandled. One broken user-configured server must never take Stem down.
//  - a dead child is remembered as dead (`alive`), so nothing reuses it and the
//    host can report the server as failed rather than hanging on a pipe nobody
//    is reading.
//  - every request has its own timeout, so a server that accepts a call and then
//    says nothing fails that call instead of leaking a promise forever.
//
// Not copied: the OAuth refresh path. A device-located server's OAuth token is
// held by the server (mcp-oauth.json), and the spec that travels down to a
// device carries no token field at all — see DeviceMcpSpec. A URL server with a
// static `Authorization` header works here today because headers travel with the
// spec; an OAuth one is a later step's problem, and porting a refresh loop with
// nothing to refresh would be dead code pretending otherwise.

/** One MCP tool as its server describes it, straight off `tools/list`. */
export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

/**
 * What the host needs from a connected server, and the only surface it uses.
 * Both clients below implement it, which is what lets `connect()` decide stdio
 * or HTTP once and nothing downstream care again.
 */
export interface McpClient {
  /** False once the connection is known to be gone; never reused when false. */
  readonly alive: boolean;
  /** Open the transport. May throw — the caller turns that into a failed server. */
  start(): void;
  /** initialize + tools/list. The tools it resolves with are the server's own. */
  handshake(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  /** Best-effort teardown. Safe to call twice, and on a client that never started. */
  stop(): void;
}

/** How long one JSON-RPC request may take before it is failed. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The protocol version and identity both clients announce at initialize. */
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'stem-device-host', version: '1.0.0' };

/** Newline-delimited JSON-RPC 2.0 over a spawned child's stdio. */
export class McpStdioClient implements McpClient {
  alive = false;
  private proc: ChildProcess | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  constructor(
    private readonly name: string,
    private readonly spec: DeviceMcpSpec
  ) {}

  start(): void {
    if (!this.spec.command?.trim()) throw new Error(`${this.name} has no command to run.`);
    this.proc = spawn(this.spec.command, this.spec.args ?? [], {
      // The spawned server inherits this machine's environment and then the
      // spec's own on top, which is what makes a stdio server pinned here mean
      // anything: it finds this user's PATH, this user's home, this user's files.
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.alive = true;
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      let i: number;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.onLine(line);
      }
    });
    // Drained and dropped. An MCP server's stderr is its own log; left unread it
    // fills the pipe buffer and blocks the child mid-write.
    this.proc.stderr?.on('data', () => undefined);
    // A missing or unspawnable binary (ENOENT and friends) arrives here, and an
    // unhandled 'error' on a ChildProcess is fatal to the whole process. One
    // mistyped command in one user's mcp.json must cost that server and nothing
    // else — so it is treated exactly like an exit.
    this.proc.on('error', (err: Error) => this.die(`${this.name} failed to start: ${err.message}`));
    this.proc.on('exit', () => this.die(`${this.name} exited`));
  }

  /** The child is gone: remember that, and fail everything waiting on it. */
  private die(why: string): void {
    this.alive = false;
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear();
  }

  stop(): void {
    this.alive = false;
    try {
      this.proc?.kill();
    } catch {
      // already gone
    }
  }

  private onLine(line: string): void {
    let msg: { id?: number; error?: { message?: string }; result?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // a server that also prints prose on stdout; not our business
    }
    if (msg.id === undefined) return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || 'MCP error'));
    else waiter.resolve(msg.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    // Checked before an id is minted: writing to a dead child's stdin throws
    // EPIPE from somewhere unhelpful, and the honest sentence is this one.
    if (!this.alive || !this.proc?.stdin?.writable) {
      return Promise.reject(new Error(`${this.name} is not running.`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${this.name} ${method} timed out.`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      this.proc!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async handshake(): Promise<McpToolDefinition[]> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    });
    this.notify('notifications/initialized', {});
    return toolsOf(await this.request('tools/list', {}));
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args ?? {} });
  }
}

/**
 * JSON-RPC over HTTP POST — MCP's Streamable-HTTP transport, opened from this
 * machine, which is the entire point for a URL like `http://nas.local:8123/mcp`
 * that a datacentre cannot route to.
 *
 * Handles both `application/json` and `text/event-stream` replies and carries
 * the `Mcp-Session-Id` the server hands back at initialize.
 */
export class McpHttpClient implements McpClient {
  // Stateless — every call is a fresh fetch — so an initialized client stays
  // usable until something stops it. `stop()` is what makes it unusable.
  alive = false;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(
    private readonly name: string,
    private readonly spec: DeviceMcpSpec
  ) {}

  start(): void {
    if (!this.spec.url?.trim()) throw new Error(`${this.name} has no URL to open.`);
    this.alive = true;
  }

  stop(): void {
    this.alive = false;
  }

  private async rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    if (!this.alive) throw new Error(`${this.name} is not connected.`);
    const id = notify ? undefined : this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`${this.name} ${method} timed out.`)),
      REQUEST_TIMEOUT_MS
    );
    timer.unref?.();
    try {
      const res = await fetch(this.spec.url!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...(this.spec.headers ?? {})
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, params }),
        signal: controller.signal
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (notify) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`.trim());
      }
      const contentType = res.headers.get('content-type') ?? '';
      const msg = contentType.includes('text/event-stream')
        ? parseSseResult(await res.text(), id!)
        : ((await res.json()) as { error?: { message?: string }; result?: unknown } | null);
      if (msg?.error) throw new Error(msg.error.message || 'MCP error');
      return msg ? msg.result : null;
    } catch (e) {
      // An abort surfaces as a generic AbortError; the reason is the sentence
      // that says which server and which call, so prefer it.
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error(`${this.name} ${method} timed out.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async handshake(): Promise<McpToolDefinition[]> {
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    });
    await this.rpc('notifications/initialized', {}, true);
    return toolsOf(await this.rpc('tools/list', {}));
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    return this.rpc('tools/call', { name, arguments: args ?? {} });
  }
}

/**
 * The client a spec asks for. A `url` means HTTP and anything else means a
 * command, which is the same rule mcp.json has always used — transport is read
 * off the spec, never off the location.
 */
export function connectClient(name: string, spec: DeviceMcpSpec): McpClient {
  return spec.url?.trim() ? new McpHttpClient(name, spec) : new McpStdioClient(name, spec);
}

/** `tools/list`'s result as a list, whatever the server actually sent. */
function toolsOf(result: unknown): McpToolDefinition[] {
  const tools = (result as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (t): t is McpToolDefinition => !!t && typeof t === 'object' && typeof (t as McpToolDefinition).name === 'string'
  );
}

/** Pull the JSON-RPC reply for `id` out of an SSE body (one or more data: frames). */
function parseSseResult(text: string, id: number): { error?: { message?: string }; result?: unknown } | null {
  for (const frame of text.split(/\n\n+/)) {
    const data = frame
      .split(/\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg && (msg.id === id || msg.result !== undefined || msg.error !== undefined)) return msg;
    } catch {
      // comments and keep-alives
    }
  }
  return null;
}
