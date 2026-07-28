// What a phone may do. This is the least-privilege layer of the bridge's security
// model: it applies AFTER the bearer token, so even a fully authenticated client
// only reaches what is written down here. Anything absent is rejected.
//
// The IPC surface is ~110 channels; the phone gets 13. The list is kept down to
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
//   - the filesystem surface (`files:add/remove/reveal`, `cfolders:*`,
//     `dialog:*`) — these move real files around or open native pickers on a
//     machine nobody is sitting at. `files:preview` is read-only and stays.
//   - the desktop's own windows (`quickchat:*`, `main:reveal`, `runtime:restart`).
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

/** Channels the phone may call through POST /rpc. */
export const MOBILE_INVOKE_CHANNELS: ReadonlySet<string> = new Set([
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

  // Image previews for attachments already in the Files place.
  'files:preview',

  // Approvals. A turn started from the phone can block on one of these three,
  // and the phone is the only surface in front of the user at that moment.
  'exec:resolveApproval',
  'mcp:adminDecision',
  'instructions:resolveApproval',

  // Read-only settings the client renders from (model labels, note-mode config).
  'settings:get'
]);

/** Channels main may push down the SSE stream. */
export const MOBILE_PUSH_CHANNELS: ReadonlySet<string> = new Set([
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

  // MCP tool availability, so the phone's activity rows can name tools correctly.
  'mcp:status'
]);

/** Whether the phone may invoke `channel` over /rpc. */
export function isMobileInvocable(channel: string): boolean {
  return MOBILE_INVOKE_CHANNELS.has(channel);
}

/** Whether `channel` may be pushed to the phone over the SSE stream. */
export function isMobilePushable(channel: string): boolean {
  return MOBILE_PUSH_CHANNELS.has(channel);
}
