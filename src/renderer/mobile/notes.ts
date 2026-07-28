import { detectNoteTrigger, noteBodyValid, type NoteFlash } from '../noteMode';

// Where a phone draft goes: to memory as a note, or to the backend as a turn.
//
// Dropping a thought without waiting for a turn is half the reason Stem is on a
// phone at all, so the `//` and `/note ` triggers are the same ones as at the
// desk — same parser, same rules — and the routing decision lives here rather
// than inside the composer so it can be tested without a DOM.
//
// The trigger only counts at the START of a draft: a question that happens to
// contain `//` (a URL, a code comment) is an ordinary question and must run as a
// turn. That rule is detectNoteTrigger's, shared with both desktop composers.

export type DraftIntent =
  | { kind: 'note'; body: string }
  /** `text` may be empty — attachments alone are a sendable turn. */
  | { kind: 'turn'; text: string }
  /** Nothing to do: an empty draft, or a bare `//` with no note in it. */
  | { kind: 'none' };

export function classifyDraft(
  draft: string,
  opts: { noteMode: boolean; hasAttachments: boolean }
): DraftIntent {
  const trimmed = draft.trim();
  // Already in note mode (the composer consumed the prefix as it was typed, or
  // the user tapped the Note button): the whole draft is the note.
  if (opts.noteMode) return noteBodyValid(trimmed) ? { kind: 'note', body: trimmed } : { kind: 'none' };
  // A trigger still on the text at submit time — a pasted `//buy milk`, say.
  const trigger = detectNoteTrigger(draft);
  if (trigger) {
    return noteBodyValid(trigger.body) ? { kind: 'note', body: trigger.body.trim() } : { kind: 'none' };
  }
  if (!trimmed && !opts.hasAttachments) return { kind: 'none' };
  return { kind: 'turn', text: trimmed };
}

/**
 * What the composer says after a note save attempt. All four outcomes are worded
 * — a swallowed failure reads as a dead send button, and on a phone the likely
 * cause (the Mac went to sleep mid-tap) is one the user can actually fix.
 */
export function noteFlashText(flash: NoteFlash): string | null {
  switch (flash) {
    case 'saved':
      return 'Saved to memory';
    case 'off':
      return 'Memory is off — note not saved';
    case 'secret':
      return 'Looks like a credential — not saved';
    case 'error':
      return 'Couldn’t save the note — try again when your Mac is awake';
    default:
      return null;
  }
}
