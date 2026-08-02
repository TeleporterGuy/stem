import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { log } from '../log';

// Runtime guard-rail for the renderer → main IPC boundary. Every invoke channel
// registered through handleIpc gets (a) a trusted-sender check — top-level frame
// of an app window only, no subframes, no foreign origins — and (b) structural
// validation of its arguments against the per-channel spec below (arity +
// shallow types). TypeScript types vanish at this boundary: a compromised or
// confused renderer can invoke any channel with anything, so main re-checks.
// Handlers keep validating domain rules; this layer only rejects calls that are
// structurally not the API.

export interface ArgSpec {
  label: string;
  ok: (v: unknown) => boolean;
  optional?: boolean;
}

const spec = (label: string, ok: (v: unknown) => boolean): ArgSpec => ({ label, ok });

export const a = {
  string: spec('a string', (v) => typeof v === 'string'),
  number: spec('a finite number', (v) => typeof v === 'number' && Number.isFinite(v)),
  boolean: spec('a boolean', (v) => typeof v === 'boolean'),
  /** A plain object payload (StartTurnInput, settings patches, …); shallow check. */
  object: spec('an object', (v) => !!v && typeof v === 'object' && !Array.isArray(v)),
  stringArray: spec('an array of strings', (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')),
  /** Approval ids arrive as the bridge's string id or a numeric card id. */
  id: spec('a string or number id', (v) => typeof v === 'string' || typeof v === 'number'),
  oneOf: (values: readonly string[]): ArgSpec =>
    spec(`one of ${values.join('|')}`, (v) => typeof v === 'string' && values.includes(v)),
  /** Also accepts null/undefined (renderer state that may legitimately be empty). */
  nullish: (s: ArgSpec): ArgSpec => ({ ...s, label: `${s.label} or null`, ok: (v) => v == null || s.ok(v) }),
  /** May be omitted entirely (trailing optional parameter). */
  optional: (s: ArgSpec): ArgSpec => ({ ...s, optional: true })
};

/**
 * Expected argument shapes per channel. A channel absent from this table takes
 * NO arguments — that is the default contract, not a gap; every argument a
 * handler reads must be declared here or the call is rejected.
 */
const IPC_ARGS: Record<string, ArgSpec[]> = {
  'auth:providerLogin': [a.string],
  'auth:setApiKey': [a.string, a.string],
  'auth:respond': [a.string, a.string],
  'auth:check': [a.string],
  // baseUrl, apiKey?, api? — api is undefined for auto-detect.
  'providers:testLocal': [
    a.string,
    a.string,
    a.optional(a.nullish(a.string)),
    a.optional(a.nullish(a.oneOf(['openai-completions', 'anthropic-messages'])))
  ],
  'providers:updateLocal': [a.string, a.object],
  'providers:disconnect': [a.string],
  'backend:startTurn': [a.object],
  'backend:interruptTurn': [a.string],
  'skills:setEnabled': [a.string, a.boolean],
  'files:add': [a.stringArray, a.optional(a.nullish(a.string))],
  'files:remove': [a.string],
  'files:mkdir': [a.string],
  'files:rmdir': [a.string],
  'files:preview': [a.string],
  'cfolders:add': [a.stringArray],
  'cfolders:update': [a.string, a.object],
  'cfolders:remove': [a.string],
  'cfolders:forgetFacts': [a.string],
  'cfolders:reveal': [a.string],
  'tasks:setEnabled': [a.string, a.boolean],
  'tasks:threadSettings': [a.string],
  'tasks:runNow': [a.string],
  'tasks:delete': [a.string],
  'tasks:updateSchedule': [a.string, a.object],
  'mcp:add': [a.object],
  'mcp:remove': [a.string],
  'mcp:setEnabled': [a.string, a.boolean],
  'mcp:login': [a.string],
  'mcp:adminDecision': [a.id, a.boolean],
  'instructions:resolveApproval': [a.id, a.boolean, a.oneOf(['main', 'quickChat']), a.string],
  'memory:setEnabled': [a.boolean],
  'memory:addNote': [a.string],
  'memory:forget': [a.number],
  'memory:setPinned': [a.number, a.boolean],
  'memory:confirmFact': [a.number],
  'memory:factDetails': [a.number],
  'memory:resolveConflict': [a.number, a.oneOf(['keep_newer', 'keep_older', 'keep_both'])],
  'memory:restoreFact': [a.number],
  'memory:deleteSummary': [a.number],
  'memory:activeFacts': [a.nullish(a.string)],
  'memory:previewFacts': [a.string],
  'memory:setEpisodicLimit': [a.number],
  'memory:setTidyThreshold': [a.number],
  'memory:setMaxRelevantFacts': [a.number],
  'chats:searchFast': [a.string],
  'chats:search': [a.string],
  'chats:open': [a.string],
  'chats:rollbackToTurn': [a.string, a.string],
  'chats:forkThread': [a.string, a.string],
  'chats:rename': [a.string, a.string],
  'chats:delete': [a.string],
  'chats:setFolder': [a.string, a.nullish(a.string)],
  'folders:create': [a.string, a.nullish(a.string)],
  'folders:rename': [a.string, a.string],
  'folders:delete': [a.string],
  'folders:move': [a.string, a.nullish(a.string)],
  'settings:updateQuickChat': [a.object],
  'settings:updateWebSearch': [a.object],
  'settings:updateEscapeAction': [a.oneOf(['off', 'single', 'twoStage'])],
  'settings:updateMemory': [a.object],
  'settings:updateSkills': [a.object],
  'settings:updateExec': [a.object],
  'exec:resolveApproval': [a.string, a.oneOf(['allowOnce', 'alwaysAllow', 'deny'])],
  'settings:updateMobile': [a.object],
  'settings:updateCustomInstructions': [a.object],
  'settings:updateRetrieval': [a.object],
  'settings:updateReleaseNotes': [a.object],
  'settings:testRetrieval': [a.oneOf(['embeddings', 'reranker'])],
  'quickchat:run': [a.object],
  'quickchat:handoff': [a.object]
};

/**
 * Why the sender is untrusted, or null when it is fine. Trusted = the top-level
 * frame of a window we created, showing our own renderer (packaged file:// or
 * the electron-vite dev server). Subframes and foreign origins never get IPC.
 */
export function senderProblem(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): string | null {
  const frame = event.senderFrame;
  if (!frame) return 'no sender frame';
  if (frame !== event.sender.mainFrame) return 'IPC from a subframe';
  const url = frame.url;
  if (url.startsWith('file://')) return null;
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev && url.startsWith(dev)) return null;
  return `untrusted sender url ${url}`;
}

/** Why `args` don't fit `specs`, or null when they do. */
export function argsProblem(specs: ArgSpec[], args: unknown[]): string | null {
  if (args.length > specs.length) return `expected at most ${specs.length} argument(s), got ${args.length}`;
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const v = args[i];
    if (v === undefined && s.optional) continue;
    if (!s.ok(v)) return `argument ${i + 1} must be ${s.label}`;
  }
  return null;
}

/**
 * ipcMain.handle with the sender check and per-channel argument validation
 * applied before the handler runs. Rejected calls throw back to the renderer's
 * invoke() and are logged; the handler is never entered.
 */
export function handleIpc(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown
): void {
  const specs = IPC_ARGS[channel] ?? [];
  localHandlers.set(channel, handler as LocalHandler);
  ipcMain.handle(channel, (event, ...args) => {
    const problem = senderProblem(event) ?? argsProblem(specs, args);
    if (problem) {
      log('ipc', `rejected ${channel}`, { problem });
      throw new Error(`Rejected IPC call to ${channel}: ${problem}.`);
    }
    return (handler as (event: IpcMainInvokeEvent, ...rest: unknown[]) => unknown)(event, ...args);
  });
}

// ---- local dispatch (surfaces that have no Electron sender) ----
//
// The phone bridge (main/mobile) receives calls over loopback HTTP, not over
// Electron IPC: there is no BrowserWindow, no frame, and therefore no
// IpcMainInvokeEvent to hand a handler. Rather than fork 110 handlers, every
// handleIpc registration is also recorded here, and dispatchLocal replays a call
// through the SAME per-channel argument validation and the SAME handler.
//
// Why passing no event is safe: no handler registered through handleIpc reads
// its event object — all call sites ignore the first parameter (the only two
// `event.sender` uses in main are ipcMain.on handlers for the Quick Chat
// handoff, which never come through here). The parameter is typed as possibly
// absent rather than cast away precisely so that a future handler which does
// reach for it has to acknowledge that it may not exist.
//
// This layer deliberately does NOT decide who may call what — that is the
// caller's job (see mobile/channels.ts for the phone's allowlist). Registering a
// channel here grants nothing on its own.

/** A registered invoke handler, viewed without the event it never reads. */
type LocalHandler = (event: IpcMainInvokeEvent | undefined, ...args: unknown[]) => unknown;

const localHandlers = new Map<string, LocalHandler>();

/** Whether `channel` has a handler registered, i.e. dispatchLocal can run it. */
export function hasLocalHandler(channel: string): boolean {
  return localHandlers.has(channel);
}

/**
 * Invoke a handleIpc-registered channel with no Electron sender: argument
 * validation first, then the handler. Rejects — with the same message shape as
 * the IPC path — when the channel has no handler or the arguments don't fit.
 */
export async function dispatchLocal(channel: string, args: unknown[]): Promise<unknown> {
  const handler = localHandlers.get(channel);
  if (!handler) throw new Error(`Rejected local call to ${channel}: no handler registered.`);
  const problem = argsProblem(IPC_ARGS[channel] ?? [], args);
  if (problem) {
    log('ipc', `rejected local ${channel}`, { problem });
    throw new Error(`Rejected local call to ${channel}: ${problem}.`);
  }
  return handler(undefined, ...args);
}
