// In-app links a reply can carry: `stem://chat/<threadId>` opens that chat and
// `stem://mail/<conversationId>` that mail conversation (read_past_chat hands
// the model these). App registers the navigator once; the markdown renderer
// asks it on click, so a link needs no prop threading through every view.

export type StemLink = { kind: 'chat'; id: string } | { kind: 'mail'; id: string };

const ID = /^[0-9a-z-]{4,64}$/i;

export function parseStemLink(href: string): StemLink | null {
  const m = /^stem:\/\/(chat|mail)\/([^/?#]+)\/?$/i.exec(href.trim());
  if (!m || !ID.test(m[2])) return null;
  return { kind: m[1].toLowerCase() as 'chat' | 'mail', id: m[2] };
}

let navigator: ((link: StemLink) => void) | null = null;

/** App's open-chat / open-mail; returns the unregister for its effect cleanup. */
export function setStemLinkNavigator(fn: (link: StemLink) => void): () => void {
  navigator = fn;
  return () => {
    if (navigator === fn) navigator = null;
  };
}

export function openStemLink(link: StemLink): void {
  navigator?.(link);
}
