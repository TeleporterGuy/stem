// Assistant output, rendered as MDX.
//
// This file stayed the single insertion point through step 5 precisely so that
// step 6 would be a change of one import. The phone used to ask the backend for
// `format:'md'` and render it with react-native-markdown-display, because MDX is
// a component vocabulary — Callout, Steps, Tabs, DataTable, Chart, Quiz, Form —
// and a half-rendered answer is worse than a plain one. That map now exists in
// ../mdx, so useThread has stopped asking for plain Markdown and the phone gets
// the same rich answers the desk does.
//
// Markdown is not lost in the trade: MDX is a superset, and an answer with no
// component tags in it walks the identical Markdown path. Nothing here special-
// cases user messages — they are plain Text in the thread screen and were never
// routed through this file.
//
// `streaming` is a hint, not a requirement: it picks the incremental renderer
// (cheap per delta, approximate at block boundaries) over the exact one. Left
// unset, every render is an exact full parse, which is correct but re-parses the
// whole reply per delta; the thread screen already knows which message is live
// (`state.streamingId`) and passing it here is the one-line upgrade.

import type { ReactNode } from 'react';
import { MdxView, StreamingMdxView } from '../mdx/MdxView';
import type { Theme } from './theme';

export function AgentMarkdown({
  text,
  theme,
  streaming = false
}: {
  text: string;
  theme: Theme;
  streaming?: boolean;
}): ReactNode {
  return streaming ? <StreamingMdxView text={text} theme={theme} /> : <MdxView text={text} theme={theme} />;
}
