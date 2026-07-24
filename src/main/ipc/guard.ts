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
  'providers:testLocal': [a.string, a.string],
  'providers:updateLocal': [a.string, a.object],
  'providers:disconnect': [a.string],
  'backend:startTurn': [a.object],
  'backend:interruptTurn': [a.string],
  'skills:setEnabled': [a.string, a.boolean],
  'files:add': [a.stringArray, a.optional(a.nullish(a.string))],
  'files:remove': [a.string],
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
  'settings:updateNativeWebSearch': [a.object],
  'settings:updateEscapeAction': [a.oneOf(['off', 'single', 'twoStage'])],
  'settings:updateMemory': [a.object],
  'settings:updateSkills': [a.object],
  'settings:updateExec': [a.object],
  'exec:resolveApproval': [a.string, a.oneOf(['allowOnce', 'alwaysAllow', 'deny'])],
  'settings:updateCustomInstructions': [a.object],
  'settings:updateRetrieval': [a.object],
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
  ipcMain.handle(channel, (event, ...args) => {
    const problem = senderProblem(event) ?? argsProblem(specs, args);
    if (problem) {
      log('ipc', `rejected ${channel}`, { problem });
      throw new Error(`Rejected IPC call to ${channel}: ${problem}.`);
    }
    return (handler as (event: IpcMainInvokeEvent, ...rest: unknown[]) => unknown)(event, ...args);
  });
}
