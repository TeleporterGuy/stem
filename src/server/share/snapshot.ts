// A chat or mail conversation (or one answer of it) as a public share
// snapshot (docs/public-share-design.md, "What is in a snapshot"). Chat
// history is already free of recall, file and mail context; this drops what
// only makes sense inside Stem or would say more than the sharer meant to:
// system notices, tool rows, persona↔persona mail, memory cards, in-app
// links, and (unless asked) the user's own pictures.
import type { ChatMessage, MailItem, MessageAttachment } from '../../shared/types';
import {
  SHARE_SNAPSHOT_VERSION,
  suggestCard,
  type ShareImage,
  type ShareMessage,
  type ShareOptions,
  type SharePreview,
  type ShareScope,
  type ShareSnapshot
} from '../../shared/share';

export class ShareInputError extends Error {}

/** One message of either source, before cleaning. */
export interface SourceMessage {
  role: 'user' | 'assistant';
  /** What an anchor names: a chat turn id (question and reply share it) or a mail item id. */
  group?: string;
  /**
   * The chat turn's runtime id. A reply still on screen from its live stream
   * carries that id until the chat is reloaded from disk, so a Share click
   * right after an answer names the turn by it.
   */
  runtimeGroup?: string;
  text: string;
  author?: string;
  createdAt?: string;
  model?: string;
  /** Pictures a model made: bytes fetched from the thread they live in. */
  images?: { id: string; threadId?: string; alt?: string }[];
  /** Pictures the user attached (opt-in). */
  attachments?: MessageAttachment[];
  sources?: { url: string; title?: string }[];
}

export interface SnapshotSource {
  title: string;
  messages: SourceMessage[];
  /** Bytes of one image a thread holds (findThreadImage). */
  image(imageId: string, threadId?: string): Promise<{ mimeType: string; data: string } | null>;
}

export function chatMessages(messages: ChatMessage[]): SourceMessage[] {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.sendFailed)
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      ...(m.turnId ? { group: m.turnId } : {}),
      ...(m.runtimeTurnId ? { runtimeGroup: m.runtimeTurnId } : {}),
      text: m.content,
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      ...(m.meta?.model ? { model: m.meta.model } : {}),
      ...(m.images?.length ? { images: m.images.map((i) => ({ id: i.id, threadId: i.threadId, alt: i.prompt })) } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.sources?.length ? { sources: m.sources } : {})
    }));
}

/**
 * The mails the user sent or received, as the thread reads. Persona↔persona
 * consulting stays out (it is folded away in the app too), and so do approval
 * cards. `name` turns a persona id into the name the user knows.
 */
export function mailMessages(items: MailItem[], name: (id: string) => string): SourceMessage[] {
  return [...items]
    .sort((a, b) => a.at - b.at)
    .filter((m) => (m.from === 'user' || m.to.includes('user')) && !m.approval)
    .map((m) => {
      const fromUser = m.from === 'user';
      const text = [m.subject && !fromUser ? `**${m.subject}**` : '', m.body, m.result ?? ''].filter(Boolean).join('\n\n');
      return {
        role: fromUser ? ('user' as const) : ('assistant' as const),
        group: m.id,
        text,
        ...(fromUser ? {} : { author: name(m.from) }),
        createdAt: new Date(m.at).toISOString(),
        ...(m.images?.length ? { images: m.images.map((i) => ({ id: i.id, threadId: i.threadId, alt: i.prompt })) } : {}),
        ...(m.attachments?.length ? { attachments: m.attachments } : {})
      };
    });
}

/**
 * Pick the messages to share. `thread`: all of them. `answer`: the anchor's
 * assistant messages. `pair`: those plus the question — the anchor's own user
 * message, else the nearest one before it.
 */
export function pickMessages(messages: SourceMessage[], scope: ShareScope = 'thread', anchorId?: string): SourceMessage[] {
  if (scope === 'thread') return messages;
  if (!anchorId) throw new ShareInputError('Choose the answer to share.');
  const group = messages.filter((m) => m.group === anchorId || m.runtimeGroup === anchorId);
  const answers = group.filter((m) => m.role === 'assistant');
  if (!answers.length) throw new ShareInputError('That answer is no longer there.');
  if (scope === 'answer') return answers;
  if (group.some((m) => m.role === 'user')) return group;
  for (let i = messages.indexOf(group[0]!) - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return [messages[i]!, ...group];
  }
  return group;
}

// <FactChange …/> cards are the user's memory, with buttons that act on it.
const FACT_CHANGE_RE = /<FactChange\b[^>]*?\/>|<FactChange\b[^>]*>[\s\S]*?<\/FactChange>/g;
// <Replies> are suggested next messages: dead in a static page.
const REPLIES_RE = /<Replies\b[^>]*?\/>|<Replies\b[^>]*>[\s\S]*?<\/Replies>/g;
// [label](stem://… or file:…) keeps the label; a bare in-app URL goes.
const LOCAL_LINK_RE = /\[([^\]]*)\]\(\s*<?(?:stem|file):[^)]*\)/gi;
const BARE_LOCAL_RE = /<?\b(?:stem|file):\/\/[^\s)>\]]*>?/gi;

/** Assistant MDX with the in-app-only parts removed. */
export function cleanAssistantText(text: string): string {
  return text
    .replace(FACT_CHANGE_RE, '')
    .replace(REPLIES_RE, '')
    .replace(LOCAL_LINK_RE, '$1')
    .replace(BARE_LOCAL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** User text: same link rule; it renders as plain text anyway. */
export function cleanUserText(text: string): string {
  return text.replace(LOCAL_LINK_RE, '$1').replace(BARE_LOCAL_RE, '').trim();
}

/** "openai-codex/gpt-6.1-sol" → "gpt-6.1-sol": the provider route says nothing to a reader. */
export function modelName(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

const IMAGE_MIME_RE = /^image\/(png|jpeg|gif|webp)$/;

function dataUrlImage(dataUrl: string, alt?: string): ShareImage | null {
  const m = /^data:(image\/[a-z]+);base64,/i.exec(dataUrl);
  if (!m || !IMAGE_MIME_RE.test(m[1]!.toLowerCase())) return null;
  return { mime: m[1]!.toLowerCase(), dataUrl, ...(alt ? { alt } : {}) };
}

export async function buildSnapshot(src: SnapshotSource, opts: ShareOptions, now = Date.now()): Promise<SharePreview> {
  const scope = opts.scope ?? 'thread';
  const picked = pickMessages(src.messages, scope, opts.anchorId);
  const out: ShareMessage[] = [];
  let omittedAttachments = 0;
  for (const m of picked) {
    const images: ShareImage[] = [];
    for (const a of m.attachments ?? []) {
      if (a.kind !== 'image') continue;
      if (!opts.includeAttachments) {
        omittedAttachments++;
        continue;
      }
      let img = a.dataUrl ? dataUrlImage(a.dataUrl, a.name) : null;
      if (!img && a.imageId) {
        const hit = await src.image(a.imageId);
        if (hit) img = dataUrlImage(`data:${hit.mimeType};base64,${hit.data}`, a.name);
      }
      if (img) images.push(img);
    }
    for (const ref of m.images ?? []) {
      const hit = await src.image(ref.id, ref.threadId);
      const img = hit ? dataUrlImage(`data:${hit.mimeType};base64,${hit.data}`, ref.alt) : null;
      if (img) images.push(img);
    }
    const text = m.role === 'user' ? cleanUserText(m.text) : cleanAssistantText(m.text);
    if (!text && !images.length) continue;
    const sources = (m.sources ?? []).filter((s) => /^https?:\/\//i.test(s.url));
    out.push({
      role: m.role,
      ...(m.author ? { author: m.author } : {}),
      text,
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      ...(m.role === 'assistant' && opts.includeModel !== false && m.model ? { model: modelName(m.model) } : {}),
      ...(images.length ? { images } : {}),
      ...(sources.length ? { sources: sources.map((s) => ({ url: s.url, ...(s.title ? { title: s.title } : {}) })) } : {})
    });
  }
  if (!out.some((m) => m.role === 'assistant')) throw new ShareInputError('There is nothing to share here yet.');
  const snapshot: ShareSnapshot = {
    v: SHARE_SNAPSHOT_VERSION,
    kind: scope === 'thread' ? 'thread' : 'answer',
    title: src.title.trim() || 'Shared from Stem',
    sharedAt: now,
    messages: out
  };
  return { snapshot, bytes: Buffer.byteLength(JSON.stringify(snapshot)), omittedAttachments, card: suggestCard(snapshot) };
}
