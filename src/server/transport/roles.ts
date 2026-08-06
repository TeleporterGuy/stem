// Who may do what, per device role. Every client reaching the transport presents
// a token; that token names a device (see auth.ts) and every device carries a
// role. The role — never the token, never the socket it arrived on — decides
// which channels the client may invoke and which pushes it may receive.
//
// Two roles, and they are deliberately asymmetric:
//
//   desktop  The whole server registry (`hasLocalHandler`). There is no second
//            table to keep in step with it, because a desktop token is the
//            user's own machine: the registry IS the surface, exactly as it was
//            when the desktop reached its handlers through ipcMain. Adding a
//            server channel therefore exposes it to the desktop by construction
//            — which is the property that made this split a refactor rather than
//            a rewrite, and a desktop allowlist would be a second copy of ~110
//            channel names whose drift would be silent.
//
//            The price is written down plainly: a stolen desktop token is full
//            admin. On loopback that is equivalent to the threat model Stem has
//            always had — anything that can read the token out of the state dir
//            already has the state dir — but it is NOT equivalent over the
//            internet. Phase 2 prices device pairing, revocation, and possibly an
//            untrusted-network tier; until then `desktop` means "the user, at
//            their own machine".
//
//   phone    A curated allowlist, unchanged from the day the bridge shipped, and
//            documented in full below because the omissions are the point.
//
// ---------------------------------------------------------------------------
//
// What a phone may do. This is the least-privilege layer of the bridge's security
// model: it applies AFTER the bearer token, so even a fully authenticated client
// only reaches what is written down here. Anything absent is rejected.
//
// The IPC surface is ~110 channels; the phone gets 12. The list is kept down to
// exactly what the shipped client calls, not to what a phone client might
// plausibly want — an allowlisted channel with no caller is blast radius with no
// benefit. Adding one back when the client grows a use for it is a one-line
// change here plus its twin in renderer/mobile/transport.ts.
//
// Deliberately unreachable from a phone, and worth stating explicitly because the
// omissions are the point:
//
//   - provider auth (`auth:*`, `providers:*`) — sign-in happens at the desk.
//   - MCP server management (`mcp:add/remove/setEnabled/login`) — install-time
//     decisions, and `mcp:login` opens a browser on the Mac.
//   - settings WRITES (`settings:update*`) — a phone can read settings, not
//     reconfigure Stem; that includes never turning the bridge off from itself.
//   - memory mutation beyond `memory:addNote` — no forget/pin/conflict
//     resolution/reset, all of which are destructive and hard to undo on a phone.
//   - the filesystem surface (`files:add/remove/reveal`, `files:preview`,
//     `cfolders:*`, `dialog:*`) — these move real files around or open native
//     pickers on a machine nobody is sitting at. `files:preview` is read-only,
//     which is not the same as harmless: it hands back ANY readable .png/.jpg/
//     .gif/.webp on the Mac as a data URL, with no containment check. The phone
//     never calls it — it is reached only from the `att.path` branch of
//     renderer/attachments.ts, and a phone's attachments are always base64 —
//     so it was blast radius with no caller.
//   - `runtime:restart`. (The desktop's own windows — `quickchat:*`,
//     `main:reveal`, `dialog:*`, the reveal handlers — are not on this list
//     because they are not server channels at all: the client answers them
//     itself and they never reach a transport. See desktop/ipc-bridge.ts.)
//   - chat MANAGEMENT (`chats:rename/delete/setFolder/forkThread`, `folders:*`,
//     `chats:search*`). The plan allowed for these, but the phone client the
//     stages actually built has no UI for any of them — its chat list opens and
//     continues threads and nothing else, and it drops the folder tree on purpose
//     (folders organize a sidebar, not a phone screen). Two of them delete real
//     things, so they stay out until something calls them.
//   - model selection (`backend:listModels`) and `runtime:status`. The phone
//     shows connection state from the SSE stream itself, and picking a model is
//     out of scope; a thread's own model is preserved via `tasks:threadSettings`.
//
// Keep the two lists sorted by namespace and keep the comments: this file is the
// documentation of the phone's blast radius, not just a lookup table.

import { hasLocalHandler } from '../ipc/guard';
import type { AppSettings } from '../../shared/types';
import { mobileSettingsView } from '../workspace/settings';

/**
 * What a device is trusted to be. Persisted on the device record (auth.ts), so a
 * role is never something the client presenting the token gets to assert.
 */
export type DeviceRole = 'desktop' | 'phone';

/** Channels the phone may call through POST /rpc. */
export const PHONE_INVOKE_CHANNELS: ReadonlySet<string> = new Set([
  // Running turns — the point of the whole exercise. startTurn carries
  // attachments as base64 (pi/attachments.ts accepts dataBase64 for any file),
  // so no upload endpoint is needed. interruptTurn and rollbackToTurn come from
  // the shared session/turns.ts the phone reuses: stop a reply, or retract the
  // message that started it.
  'backend:startTurn',
  'backend:interruptTurn',
  'chats:rollbackToTurn',

  // The model/effort a thread was last explicitly put on. Read-only, and the
  // phone needs it for one reason: pi does NOT restore a session's own model on
  // switch_session (the spawn-time --model pins every rebuild), so continuing a
  // thread started at the desk without re-pinning it would silently run it on
  // the app default. The scheduler resolves its headless runs the same way.
  // Nothing else in `tasks:*` is reachable — a phone cannot create, edit, run or
  // delete a scheduled task.
  'tasks:threadSettings',

  // The chat list, and opening/continuing any thread started at the desk.
  'chats:list',
  'chats:open',

  // Memory: capture a note (`//` note mode) and READ what Stem knows. Nothing
  // here mutates or deletes a fact.
  'memory:addNote',
  'memory:activeFacts',

  // Approvals. A turn started from the phone can block on one of these three,
  // and the phone is the only surface in front of the user at that moment.
  'exec:resolveApproval',
  'mcp:adminDecision',
  'instructions:resolveApproval',
  'skills:resolveApproval',

  // Read-only settings. The phone reads exactly one field out of this:
  // `customInstructions.main`, which the instructions approval sheet shows as
  // the text it is asking about. The answer is projected before it leaves (see
  // PHONE_POLICY) — settings.json also holds every API key the user has typed.
  'settings:get'
]);

/**
 * A second gate for the channels where "may the phone call this?" is not the
 * whole question. The allowlist above decides IF; this decides WITH WHAT, and
 * WITH WHAT BACK. Both halves of the trust boundary stay in this one file.
 */
export interface ChannelPolicy {
  /** Rewrite or reject the args a phone sent. Throwing rejects the call (400). */
  args?: (args: unknown[]) => unknown[];
  /** Narrow what goes back down the wire. */
  result?: (result: unknown) => unknown;
}

/**
 * The phone's half of `backend:startTurn` — the one allowlisted channel that
 * hands the server a whole object to act on. Two fields of StartTurnInput say
 * something a phone is not entitled to say:
 *
 *   - `attachments[].path`. pi/attachments.ts reads that path off the Mac's
 *     disk and inlines the bytes into the prompt, with no containment check of
 *     any kind — so a path attachment is a read-any-file primitive for whoever
 *     holds a pairing token. The shipped client cannot even produce one: it
 *     base64s the File it was given (renderer/mobile/attachments.ts), because a
 *     phone shares no filesystem with the Mac. A `path` arriving here is a bug
 *     or an attack, and both deserve a refusal rather than a silent drop.
 *   - `scheduled`. That is the scheduler's headless-run marker, stamped by the
 *     server on its own runs: it changes the preamble the backend prepends and
 *     makes the UI render the turn collapsed. A client setting it is forging
 *     provenance. Dropping it is what the caller actually wants, though — the
 *     turn is a perfectly good interactive turn without it — so this one is
 *     removed rather than refused.
 */
function startTurnArgs(args: unknown[]): unknown[] {
  const input = args[0];
  // Not a StartTurnInput at all: leave it to dispatchLocal's arg-spec check, so
  // it is refused with the same words the desk would get.
  if (!input || typeof input !== 'object' || Array.isArray(input)) return args;
  const attachments = (input as { attachments?: unknown }).attachments;
  if (Array.isArray(attachments) && attachments.some((att) => !!att && typeof att === 'object' && 'path' in att)) {
    throw new Error('attachments must be inline (dataBase64); path attachments are not available on mobile');
  }
  // A copy, never the caller's object: this runs on the request's parsed body,
  // and nothing downstream should see a mutation from up here.
  const sanitized = { ...(input as Record<string, unknown>) };
  delete sanitized.scheduled;
  return [sanitized, ...args.slice(1)];
}

const PHONE_POLICY: Readonly<Record<string, ChannelPolicy>> = {
  'backend:startTurn': { args: startTurnArgs },
  'settings:get': { result: (result) => mobileSettingsView(result as AppSettings) }
};

/** Channels the server may push down the SSE stream to a phone. */
export const PHONE_PUSH_CHANNELS: ReadonlySet<string> = new Set([
  // The streaming turn itself: deltas, activity rows, terminal events.
  'backend:event',

  // The three approval request/resolved pairs. `*Resolved` matters as much as
  // the request: it retracts a card the user answered on the other surface.
  'exec:approvalRequest',
  'exec:approvalResolved',
  'mcp:adminApproval',
  'mcp:adminApprovalResolved',
  'instructions:approvalRequest',
  'instructions:approvalResolved',
  'skills:approvalRequest',
  'skills:approvalResolved',

  // MCP tool availability, so the phone's activity rows can name tools correctly.
  'mcp:status'
]);

/** Whether `role` may invoke `channel` over /rpc. */
export function mayInvoke(role: DeviceRole, channel: string): boolean {
  return role === 'desktop' ? hasLocalHandler(channel) : PHONE_INVOKE_CHANNELS.has(channel);
}

/** Whether `channel` may be pushed to `role` over the SSE stream. */
export function mayReceive(role: DeviceRole, channel: string): boolean {
  return role === 'desktop' ? true : PHONE_PUSH_CHANNELS.has(channel);
}

/** The extra args/result handling `channel` needs for `role`, if any. */
export function channelPolicy(role: DeviceRole, channel: string): ChannelPolicy | undefined {
  return role === 'phone' ? PHONE_POLICY[channel] : undefined;
}

/**
 * Every channel `role` may invoke, out of the ones actually registered. A client
 * asks for this at connect time so it knows what to expose (see GET /channels);
 * it is derived from the predicate above rather than being a third list.
 */
export function channelsFor(role: DeviceRole, registered: readonly string[]): string[] {
  return registered.filter((channel) => mayInvoke(role, channel));
}
