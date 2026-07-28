import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Camera, Check, File, NotebookPen, Paperclip, Square, X } from 'lucide-react';
import type { TurnAttachment } from '../../shared/types';
import { detectNoteTrigger, useNoteMode } from '../noteMode';
import { attachmentProblem, fileToAttachment } from './attachments';
import { classifyDraft, noteFlashText } from './notes';

// The phone composer. Deliberately not the desktop one: that one carries model /
// effort / speed / format pickers, the context meter, drag-and-drop and
// paste-to-attach — none of which belong on a phone, and several of which are
// decisions the user made to keep at the desk.
//
// What it does carry, because both are things you reach for a phone to do:
//
//   * Note mode. `//` or `/note ` at the start of the draft saves a memory note
//     instead of running a turn — the same triggers, the same parser and the same
//     hook as both desktop composers (renderer/noteMode.ts). All four outcomes
//     are shown: a swallowed failure reads as a dead send button.
//   * Attachments. A photo or a file goes up as base64 inside startTurn; there is
//     no upload endpoint and no shared filesystem. The size ceiling is checked
//     before the read (see ./attachments) so an over-sized photo fails as a
//     sentence rather than as the bridge's 413.
//
// Enter inserts a newline here rather than sending. On a touch keyboard the
// return key is the only way to write a second line, and there is a send button
// right next to it; the desktop's Enter-to-send would make multi-line prompts
// impossible to type.

/** Cap on auto-grow, in pixels — beyond this the field scrolls instead. */
const MAX_FIELD_PX = 160;

export function Composer({
  running,
  onSend,
  onInterrupt
}: {
  running: boolean;
  onSend: (text: string, attachments: TurnAttachment[]) => void;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<TurnAttachment[]>([]);
  /** Why the last pick was refused (too big, unreadable) — never silent. */
  const [attachError, setAttachError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const { noteMode, flash, enterNoteMode, exitNoteMode, saveNote } = useNoteMode();

  // Auto-grow: reset to one row first so the field can shrink again on delete.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, MAX_FIELD_PX)}px`;
  }, [text]);

  const intent = classifyDraft(text, { noteMode, hasAttachments: attachments.length > 0 });

  function submit(): void {
    if (intent.kind === 'none') return;
    if (intent.kind === 'note') {
      // A note never touches the backend, so it is allowed mid-turn.
      void saveNote(intent.body).then((saved) => {
        if (saved) setText('');
      });
      return;
    }
    if (running) return;
    setText('');
    setAttachments([]);
    setAttachError(null);
    onSend(intent.text, attachments);
  }

  /**
   * Take what the picker handed back. Files are read one at a time and against
   * the running total, so the first one that would blow the turn's budget stops
   * the batch with its own message instead of every file failing at send.
   */
  async function addFiles(picked: FileList | null): Promise<void> {
    if (!picked || picked.length === 0) return;
    setAttachError(null);
    const accepted: TurnAttachment[] = [];
    for (const file of Array.from(picked)) {
      const problem = attachmentProblem(file, [...attachments, ...accepted]);
      if (problem) {
        setAttachError(problem);
        break;
      }
      try {
        accepted.push(await fileToAttachment(file));
      } catch (e) {
        setAttachError(e instanceof Error ? e.message : String(e));
        break;
      }
    }
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
  }

  const flashText = noteFlashText(flash);

  return (
    <div className="m-composer">
      {noteMode && (
        <div className="m-composer-chips">
          <span className="attachment-chip note-chip">
            <NotebookPen size={13} />
            <span className="attachment-name">Note to memory</span>
            <button type="button" className="attachment-remove" aria-label="Back to chat" onClick={exitNoteMode}>
              <X size={13} />
            </button>
          </span>
        </div>
      )}
      {flashText && (
        <div className="m-composer-chips">
          <span className={`note-flash${flash === 'saved' ? ' ok' : ''}`} role="status" aria-live="polite">
            {flash === 'saved' && <Check size={13} />}
            {flashText}
          </span>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="m-composer-chips">
          {attachments.map((att, i) => (
            <span className="attachment-chip" key={`${att.name}-${i}`}>
              <File size={13} />
              <span className="attachment-name">{att.name}</span>
              <button
                type="button"
                className="attachment-remove"
                aria-label={`Remove ${att.name}`}
                onClick={() => setAttachments((prev) => prev.filter((_, at) => at !== i))}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      {attachError && (
        <p className="m-composer-error" role="status">
          {attachError}
        </p>
      )}
      <div className={`m-composer-field${noteMode ? ' note-mode' : ''}`}>
        {/* Two pickers on purpose. The plain one is everything the OS offers
            (photo library, files, and iOS's own "Take Photo" entry); the camera
            one goes straight to the camera, which is the whole point of writing
            to Stem from a phone in the first place. Both are real inputs laid
            over their button so they keep focus and keyboard access. */}
        {!noteMode && (
          <>
            <label className="m-attach" aria-label="Attach a file">
              <Paperclip size={17} />
              <input
                type="file"
                multiple
                onChange={(e) => {
                  void addFiles(e.target.files);
                  // Clear it, or picking the same file twice fires no change.
                  e.target.value = '';
                }}
              />
            </label>
            <label className="m-attach" aria-label="Take a photo">
              <Camera size={17} />
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </>
        )}
        <textarea
          ref={fieldRef}
          rows={1}
          value={text}
          placeholder={noteMode ? 'Save a note to memory…' : 'Ask Stem anything…'}
          enterKeyHint="enter"
          onChange={(e) => {
            const value = e.target.value;
            // Typing `//` or `/note ` at the start flips into note mode and the
            // prefix is consumed — the chip above replaces it, exactly as at the
            // desk. Mid-message the same characters are ordinary text.
            const trigger = noteMode ? null : detectNoteTrigger(value);
            if (trigger) {
              enterNoteMode();
              setText(trigger.body);
            } else {
              setText(value);
            }
          }}
          // The keyboard overlays the page on iOS even with the resize hint, so
          // pull the composer back into view once it has settled.
          onFocus={() => {
            window.setTimeout(() => fieldRef.current?.scrollIntoView({ block: 'nearest' }), 250);
          }}
        />
        {running && !noteMode ? (
          <button type="button" className="icon-btn stop" aria-label="Stop" onClick={onInterrupt}>
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            aria-label={noteMode ? 'Save note' : 'Send'}
            disabled={intent.kind === 'none'}
            onClick={submit}
          >
            {noteMode ? <NotebookPen size={16} /> : <ArrowUp size={17} />}
          </button>
        )}
      </div>
    </div>
  );
}
