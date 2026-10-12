import type { ChatMessage } from '../../shared/types';

// read_past_chat: one earlier chat (or mail conversation thread) handed back to
// the model as a transcript plus the pictures the user attached to it. The
// recall searches only return text snippets, so a chat whose substance was a
// photo (an order form, a receipt) could be found but never read: the model
// ended up asking the user to send the picture again.

/** Text the transcript may bring into context per call; the rest is paged. */
export const PAST_CHAT_TEXT_BUDGET = 40_000;
/** One message's share, so a pasted log cannot eat the whole page. */
const MESSAGE_MAX_CHARS = 6_000;
/** Pictures per call. Each is a full image block in the model's context. */
export const PAST_CHAT_MAX_IMAGES = 4;

export interface PastChatImage {
  data: string;
  mimeType: string;
}

/**
 * The link a reply should use for this chat. Clients open `stem://chat/<id>` as
 * a chat and `stem://mail/<id>` as a mail conversation; a thread behind a mail
 * conversation links to the conversation, since its hidden thread is not
 * something the user can open.
 */
export function pastChatLink(target: { threadId: string; mailConversationId?: string | null }): string {
  return target.mailConversationId
    ? `stem://mail/${target.mailConversationId}`
    : `stem://chat/${target.threadId}`;
}

function dataUrlImage(dataUrl: string | undefined): PastChatImage | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl ?? '');
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/**
 * Render one page of a chat. `offset` is the 0-based message index to start
 * at; the page stops at the text budget or the image cap, whichever comes
 * first, and says where to continue.
 */
export function formatPastChat(input: {
  title: string;
  link: string;
  messages: ChatMessage[];
  offset?: number;
  images?: boolean;
}): { text: string; images: PastChatImage[] } {
  const messages = input.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const start = Math.max(0, Math.floor(input.offset ?? 0));
  const head =
    `Chat "${input.title}" — link it in your reply as [${input.title}](${input.link}).\n` +
    `${messages.length} messages.`;
  if (start >= messages.length) {
    return {
      text: messages.length ? `${head}\nOffset ${start} is past the last message.` : `${head}\nThis chat has no messages.`,
      images: []
    };
  }
  const images: PastChatImage[] = [];
  const parts: string[] = [];
  let used = 0;
  let end = start;
  for (; end < messages.length; end++) {
    const m = messages[end];
    const pics = (m.attachments ?? []).filter((a) => a.kind === 'image');
    // Never split a message from its pictures across pages: stop before one
    // that would overflow the image cap, unless it is the first on the page.
    if (input.images !== false && images.length && images.length + pics.length > PAST_CHAT_MAX_IMAGES) break;
    const date = m.createdAt ? m.createdAt.slice(0, 16).replace('T', ' ') : '';
    const who = m.role === 'user' ? 'User' : 'Assistant';
    let body = m.content.trim();
    if (body.length > MESSAGE_MAX_CHARS) body = `${body.slice(0, MESSAGE_MAX_CHARS)} […cut]`;
    const notes: string[] = [];
    for (const a of pics) {
      const img = input.images !== false && images.length < PAST_CHAT_MAX_IMAGES ? dataUrlImage(a.dataUrl) : null;
      if (img) {
        images.push(img);
        notes.push(`[picture ${images.length} — attached below]`);
      } else {
        notes.push('[picture not shown]');
      }
    }
    for (const a of m.attachments ?? []) if (a.kind === 'file') notes.push(`[file: ${a.name ?? 'attachment'}]`);
    if (m.images?.length) notes.push(`[${m.images.length} generated picture(s)]`);
    const entry = `#${end} ${who}${date ? ` (${date})` : ''}: ${[body, ...notes].filter(Boolean).join('\n')}`;
    if (parts.length && used + entry.length > PAST_CHAT_TEXT_BUDGET) break;
    parts.push(entry);
    used += entry.length;
  }
  const more = end < messages.length ? `\n\n[Messages ${start}–${end - 1} shown. Continue with offset=${end}.]` : '';
  return { text: `${head}\n\n${parts.join('\n\n')}${more}`, images };
}
