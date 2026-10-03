import type { ChatMessage, ChatPin } from '../../shared/types';

// The chat pinboard's pure parts (docs/chat-pinboard-plan.md): what the collapsed
// strip says, which message a pin points at, and the per-chat docked flag. Kept
// out of PinBoard.tsx so they are tested without React.

/** Words a pin with no label yet shows in the collapsed strip. */
const FALLBACK_WORDS = 4;

/**
 * The anchor a message is pinned under: its runtime turn id when it has one —
 * the same live, after a reload and in a fork — else its persisted turn id.
 * Null for a message nothing can be pinned from (an optimistic bubble, an error).
 */
export function messageAnchor(m: ChatMessage): string | null {
  return m.runtimeTurnId ?? m.turnId ?? null;
}

/** A pin's short name: its label, or its first few words until one is written. */
export function pinLabel(pin: ChatPin): string {
  if (pin.label) return pin.label;
  const words = pin.text.replace(/\s+/g, ' ').trim().split(' ');
  const head = words.slice(0, FALLBACK_WORDS).join(' ');
  return words.length > FALLBACK_WORDS ? `${head}…` : head;
}

/** The collapsed strip's summary: every pin's short name, in board order. */
export function pinSummary(pins: ChatPin[]): string {
  return pins.map(pinLabel).join(' · ');
}

/**
 * The message a pin was taken from, if it is still in the chat. A pin matches on
 * either of a message's turn ids (a pin made from a live bubble and the same
 * message reloaded agree on the runtime id; older turns only have the persisted
 * one) and on role. A turn that rebuilt as several assistant bubbles is narrowed
 * by the pinned text, falling back to the turn's last bubble of that role.
 */
export function pinSource(pin: ChatPin, messages: ChatMessage[]): ChatMessage | null {
  if (!pin.anchor || !pin.role) return null;
  const candidates = messages.filter(
    (m) => m.role === pin.role && (m.runtimeTurnId === pin.anchor || m.turnId === pin.anchor)
  );
  if (candidates.length === 0) return null;
  const needle = pin.text.trim();
  return candidates.find((m) => m.content.includes(needle)) ?? candidates[candidates.length - 1];
}

const DOCKED_KEY = 'stem.pinboard.docked';

/**
 * Which chats keep their board docked open. A per-viewer convenience, so it
 * lives in this window's storage rather than on the server; storage can be
 * missing or throw (private window, cleared site data), and then every board
 * simply starts floating.
 */
export function readDocked(threadId: string): boolean {
  try {
    const raw = localStorage.getItem(DOCKED_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(ids) && ids.includes(threadId);
  } catch {
    return false;
  }
}

export function writeDocked(threadId: string, docked: boolean): void {
  try {
    const raw = localStorage.getItem(DOCKED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    const ids = new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
    if (docked) ids.add(threadId);
    else ids.delete(threadId);
    localStorage.setItem(DOCKED_KEY, JSON.stringify([...ids]));
  } catch {
    // Not remembered; the board still docks for this session.
  }
}
