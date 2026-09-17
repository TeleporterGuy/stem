import { log } from '../../server/log';
import type {
  ComputerAccess,
  ComputerHostLocalState,
  DeviceComputerRequest,
  DeviceComputerResult
} from '../../shared/types';
import { HelperProcess, oneShot, resolveHelperPath, type HelperEvent, type HelperReply } from './helper';
import { readComputerHostEnabled, writeComputerHostEnabled } from './store';

// The client half of the `computer` tool: THIS Mac, performing the screen
// actions its Stem server sends over the addressed frame (shared/types.ts,
// COMPUTER_REQUEST_FRAME) and answering with a screenshot.
//
// What this file trusts and what it does not: the request arrived over this
// client's own authenticated stream, and the server already checked the
// persona pin. What it never delegates are the two decisions that belong to
// the person at this machine — whether Stem may drive the screen at all (the
// switch, read fresh from this disk on every request), and when a run ends:
// the helper watches for the person's own input and the first touch aborts
// everything, here, before the server hears of it.
//
// A "run" is one thread's stretch of actions: it begins with the first action
// for that thread (helper spawned, watch on, banner up) and ends when the
// server says the turn is over (COMPUTER_END_FRAME), when the person takes
// over, or when nothing has been asked for IDLE_MS — the belt against a lost
// end frame, so the banner can never stick.

const IDLE_MS = 5 * 60 * 1000;

export type { ComputerHostLocalState };

/** What the host needs of a running helper — the real one is HelperProcess; tests fake it. */
export interface HelperLike {
  call(cmd: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<HelperReply>;
  onEvent(listener: (event: HelperEvent) => void): () => void;
  kill(): void;
}

export interface ComputerHostDeps {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  banner: { show(): void; hide(): void };
  /** How a helper is started and asked one-off questions; defaults to the real binary. */
  helpers?: {
    spawn(): Promise<HelperLike>;
    oneShot(cmd: string): Promise<HelperReply>;
  };
}

const realHelpers: NonNullable<ComputerHostDeps['helpers']> = {
  spawn: async () => new HelperProcess(await resolveHelperPath()),
  oneShot: (cmd) => oneShot(cmd)
};

export interface ComputerHost {
  start(): Promise<void>;
  refresh(): Promise<void>;
  /** An action arrived on the event stream. Never throws; answers over RPC. */
  onRequest(request: DeviceComputerRequest): void;
  /** The server says this thread's run is over. */
  onEnd(end: { threadId: string }): void;
  localState(): Promise<ComputerHostLocalState>;
  setEnabled(enabled: boolean): Promise<ComputerHostLocalState>;
  /** Ask macOS for the missing grants (prompts appear); answers with the state afterwards. */
  requestAccess(): Promise<ComputerHostLocalState>;
  /** Quit: end any run, kill the helper. */
  close(): void;
}

interface Run {
  threadId: string;
  helper: HelperLike;
  idle: NodeJS.Timeout;
  /** The request being served, so a take-over can fail it at once. */
  inFlight: {
    requestId: string;
    fail(result: DeviceComputerResult): void;
  } | null;
  aborted: boolean;
}

export function createComputerHost(deps: ComputerHostDeps): ComputerHost {
  const supported = process.platform === 'darwin';
  const helpers = deps.helpers ?? realHelpers;
  let run: Run | null = null;
  let lastAccess: ComputerAccess | null = null;

  async function checkAccess(): Promise<ComputerAccess | null> {
    if (!supported) return null;
    try {
      const reply = await helpers.oneShot('status');
      if (reply.ok && reply.status) lastAccess = reply.status;
    } catch (e) {
      log('computer-host', 'could not read the helper status', {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return lastAccess;
  }

  async function announce(): Promise<void> {
    if (!supported) return;
    const enabled = await readComputerHostEnabled();
    const access = enabled ? await checkAccess() : lastAccess;
    await deps
      .invoke('computerHost:announce', [{ enabled, platform: 'darwin', ...(access ? { access } : {}) }])
      .catch((e) => {
        // An older server has no such channel; this Mac simply cannot be a target there.
        log('computer-host', 'could not announce', {
          error: e instanceof Error ? e.message : String(e)
        });
      });
  }

  function state(): ComputerHostLocalState {
    return { supported, enabled: false, access: lastAccess };
  }

  function touch(r: Run): void {
    clearTimeout(r.idle);
    r.idle = setTimeout(() => endRun(r, 'idle'), IDLE_MS);
    r.idle.unref?.();
  }

  function endRun(r: Run, why: string): void {
    if (run !== r) return;
    run = null;
    clearTimeout(r.idle);
    r.inFlight?.fail({ ok: false, error: 'The run ended.' });
    r.inFlight = null;
    r.helper.kill();
    deps.banner.hide();
    log('computer-host', 'a computer-control run ended', {
      threadId: r.threadId,
      why
    });
  }

  /** The person touched the mouse or keyboard: over, now. */
  function humanTookOver(r: Run, kind: string): void {
    if (run !== r || r.aborted) return;
    r.aborted = true;
    log('computer-host', 'the user took over', { threadId: r.threadId, kind });
    r.inFlight?.fail({
      ok: false,
      error: 'The user took over the computer.',
      aborted: true
    });
    r.inFlight = null;
    void deps.invoke('computerHost:event', [{ threadId: r.threadId, kind: 'human-input' }]).catch((e) => {
      log('computer-host', 'could not report the take-over', {
        error: e instanceof Error ? e.message : String(e)
      });
    });
    endRun(r, 'human-input');
  }

  async function beginRun(threadId: string): Promise<Run> {
    const helper = await helpers.spawn();
    const r: Run = {
      threadId,
      helper,
      idle: setTimeout(() => undefined, 0),
      inFlight: null,
      aborted: false
    };
    helper.onEvent((event) => {
      if (event.event === 'human-input') humanTookOver(r, event.kind);
    });
    // The kill switch is not optional: a run without the watch is a run the
    // person cannot stop by touching their own machine, so it does not start.
    const watched = await helper.call('watch', { on: true });
    if (!watched.ok) {
      helper.kill();
      throw new Error(watched.error ?? 'Could not watch for your input.');
    }
    run = r;
    touch(r);
    deps.banner.show();
    log('computer-host', 'a computer-control run began', { threadId });
    return r;
  }

  function helperCommand(action: DeviceComputerRequest['action']): {
    cmd: string;
    fields: Record<string, unknown>;
  } {
    switch (action.kind) {
      case 'screenshot':
        return { cmd: 'screenshot', fields: {} };
      case 'cursor':
        return { cmd: 'cursor', fields: {} };
      case 'move':
        return { cmd: 'move', fields: { x: action.x, y: action.y } };
      case 'click':
        return {
          cmd: 'click',
          fields: {
            ...(action.x !== undefined ? { x: action.x, y: action.y } : {}),
            button: action.button,
            count: action.count
          }
        };
      case 'drag':
        return { cmd: 'drag', fields: { from: action.from, to: action.to } };
      case 'scroll':
        return {
          cmd: 'scroll',
          fields: {
            ...(action.x !== undefined ? { x: action.x, y: action.y } : {}),
            dir: action.dir,
            amount: action.amount
          }
        };
      case 'type':
        return { cmd: 'type', fields: { text: action.text } };
      case 'key':
        return { cmd: 'key', fields: { combo: action.combo } };
      case 'hold':
        return { cmd: 'hold', fields: { combo: action.combo, ms: action.ms } };
      case 'wait':
        return { cmd: 'wait', fields: { ms: action.ms } };
      case 'zoom':
        return {
          cmd: 'zoom',
          fields: { x: action.x, y: action.y, w: action.w, h: action.h }
        };
    }
  }

  function fromReply(reply: HelperReply): DeviceComputerResult {
    if (!reply.ok || !reply.screenshot) {
      return {
        ok: false,
        error: reply.error ?? 'The helper answered without a screenshot.'
      };
    }
    return {
      ok: true,
      screenshot: reply.screenshot,
      cursor: reply.cursor ?? { x: 0, y: 0 }
    };
  }

  async function execute(request: DeviceComputerRequest): Promise<DeviceComputerResult> {
    if (!supported)
      return {
        ok: false,
        error: 'Computer control is only available on macOS.'
      };
    // The gate, read fresh from this disk on every request.
    if (!(await readComputerHostEnabled())) {
      return {
        ok: false,
        error:
          'This Mac does not let Stem control its screen. The switch is in Settings → Chat → Computer control, ' +
          'on that computer.'
      };
    }
    // One run at a time, per Mac: a second thread's action while another
    // thread is driving would fight it for the one cursor there is.
    if (run && run.threadId !== request.threadId) {
      return {
        ok: false,
        error: 'Another conversation is controlling this Mac right now; try again when it is done.'
      };
    }
    let r = run;
    if (!r) {
      try {
        r = await beginRun(request.threadId);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    touch(r);
    const { cmd, fields } = helperCommand(request.action);
    const timeout = request.action.kind === 'wait' ? request.action.ms + 15_000 : undefined;
    return new Promise<DeviceComputerResult>((resolve) => {
      let settled = false;
      const done = (result: DeviceComputerResult): void => {
        if (settled) return;
        settled = true;
        if (r!.inFlight?.requestId === request.requestId) r!.inFlight = null;
        resolve(result);
      };
      r!.inFlight = { requestId: request.requestId, fail: done };
      void r!.helper.call(cmd, fields, timeout).then((reply) => done(fromReply(reply)));
    });
  }

  return {
    async start() {
      await announce();
    },

    refresh: () => announce(),

    onRequest(request) {
      void (async () => {
        let result: DeviceComputerResult;
        try {
          result = await execute(request);
        } catch (e) {
          result = {
            ok: false,
            error: `The action failed: ${e instanceof Error ? e.message : String(e)}`
          };
        }
        await deps.invoke('computerHost:result', [request.requestId, result]).catch((e) => {
          log('computer-host', 'could not deliver a screen result', {
            error: e instanceof Error ? e.message : String(e)
          });
        });
      })();
    },

    onEnd({ threadId }) {
      if (run && run.threadId === threadId) endRun(run, 'turn-ended');
    },

    localState: async () => ({
      ...state(),
      enabled: await readComputerHostEnabled(),
      access: await checkAccess()
    }),

    async setEnabled(enabled) {
      if (!supported) return state();
      await writeComputerHostEnabled(enabled);
      if (!enabled && run) endRun(run, 'switched-off');
      await announce();
      return { ...state(), enabled };
    },

    async requestAccess() {
      if (!supported) return state();
      try {
        const reply = await helpers.oneShot('request-access');
        if (reply.ok && reply.status) lastAccess = reply.status;
      } catch (e) {
        log('computer-host', 'could not request access', {
          error: e instanceof Error ? e.message : String(e)
        });
      }
      await announce();
      return { ...state(), enabled: await readComputerHostEnabled() };
    },

    close() {
      if (run) endRun(run, 'quit');
    }
  };
}
