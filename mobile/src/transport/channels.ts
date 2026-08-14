// Which channels the phone calls, typed by the SAME declarations the desktop
// renderer is typed by.
//
// `StemApi` (src/shared/types.ts) is the client contract: one method per thing a
// client may ask for, with the argument and answer types the server actually
// produces. The desktop reaches it through a preload bridge that maps a method
// name to a channel string; the phone has no preload, so the mapping is this
// table — channel string on the left, the StemApi method whose signature it
// carries on the right.
//
// The value of writing it down this way rather than as hand-copied types is that
// the phone cannot drift. Rename a field on ChatSummary and this file's callers
// stop compiling on the same commit that changed it, which is the only kind of
// contract that survives a codebase with two clients in it.
//
// Small on purpose: step 4 is the transport, so it carries the two channels the
// chat list needs. Adding one is a line here plus its StemApi method — never a
// new type.

import type { StemApi } from '@shared/types';

export interface ChannelSignatures {
  /** All chats, their folders, and the Inbox state that goes with them. */
  'chats:list': StemApi['listChats'];
  /** One thread's transcript. */
  'chats:open': StemApi['openChat'];
}

export type ChannelName = keyof ChannelSignatures;
export type ChannelArgs<C extends ChannelName> = Parameters<ChannelSignatures[C]>;
export type ChannelResult<C extends ChannelName> = Awaited<ReturnType<ChannelSignatures[C]>>;
