import type { StartTurnInput, StemApi, TurnAttachment } from '../../shared/types';

// What a phone turn actually asks the backend for.
//
// A NEW chat is happy to run on the app default — the phone has no model or
// effort picker by decision. CONTINUING a thread started at the desk is a
// different matter: pi does not restore a session's own model on switch_session
// (the spawn-time `--model` pins every runtime rebuild — see the comment in
// pi/runtime.ts's ensureActive), so a turn sent with no model would quietly run
// a thread the user had put on a big model back on the app default. The
// scheduler already resolves this the same way for its headless runs; the phone
// is the second caller that has no picker to read the answer off.
//
// Two things are deliberately NOT set here: `webSearch` and `instructions`.
// Main's backend:startTurn handler spreads the input and then overrides both
// from settings, so a phone turn already gets the user's standing custom
// instructions and their web-search choice. Passing them would be dead
// weight at best and a divergence at worst.

export interface MobileTurnRequest {
  text: string;
  /** The thread being continued, or null for a chat that does not exist yet. */
  threadId: string | null;
  attachments: TurnAttachment[];
}

/** The one member this needs; the tests pass a fake rather than a whole bridge. */
type ThreadSettingsReader = Pick<StemApi, 'taskThreadSettings'>;

export async function mobileStartTurnInput(
  request: MobileTurnRequest,
  api: ThreadSettingsReader = window.stem
): Promise<StartTurnInput> {
  const input: StartTurnInput = {
    input: request.text,
    // Desktop history is MDX and the phone renders it; new turns join it.
    format: 'mdx'
  };
  if (request.attachments.length > 0) input.attachments = request.attachments;
  if (!request.threadId) return input;

  input.threadId = request.threadId;
  // Best effort: a thread whose settings cannot be read (an unreachable Mac is
  // about to fail the send anyway) still runs, on the default, rather than being
  // blocked here.
  const settings = await api.taskThreadSettings(request.threadId).catch(() => null);
  if (settings?.model) input.model = settings.model;
  if (settings?.effort) input.effort = settings.effort;
  return input;
}
