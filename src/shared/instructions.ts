// The one rule for turning an assistant-proposed instructions change into the
// string that gets written.
//
// It is in shared/ rather than beside the desktop card because the backend holds
// the tool call open until a CLIENT answers, and there are now two clients that
// can. The card writes the WHOLE surface string (main is the sole writer), so
// `append` has to be resolved against the current value on the client side —
// which means each client that can approve one of these is computing the final
// instructions text itself, and two clients computing it differently is a
// silently different standing instruction depending on which device the user
// happened to tap.

import type { InstructionsProposal } from './types';

export function resolvedInstructionsText(
  action: InstructionsProposal['action'],
  incomingText: string,
  current: string
): string {
  if (action === 'clear') return '';
  if (action === 'replace') return incomingText;
  // append
  return current ? `${current}\n${incomingText}` : incomingText;
}
