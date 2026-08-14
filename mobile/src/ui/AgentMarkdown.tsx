// Assistant output, rendered as plain Markdown.
//
// The phone asks for `format:'md'` when it starts a turn (see useThread) rather
// than Stem's usual MDX, because MDX is a component vocabulary — Callout, Steps,
// Chart, Quiz — and every one of those has to be re-implemented for React
// Native before it can be shown. Asking the model for plain Markdown means the
// answer is complete on the phone rather than half-rendered, which is the right
// trade until that map exists. Step 6 builds it; when it does, the format flag
// is what changes, not this file's callers.
//
// One dependency, and a deliberate one: react-native-markdown-display is pure
// JS (no native module, so no dev-client rebuild) and takes a plain style map.
// Its styles are passed in from the theme rather than hard-coded so a bubble
// renders the same in dark mode as everything around it.

import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import type { Theme } from './theme';

/** Cached per theme object — the map is rebuilt only when the scheme flips. */
const cache = new WeakMap<Theme, ReturnType<typeof StyleSheet.create>>();

function markdownStyles(theme: Theme): ReturnType<typeof StyleSheet.create> {
  const cached = cache.get(theme);
  if (cached) return cached;
  const styles = StyleSheet.create({
    body: { color: theme.text, fontSize: 16, lineHeight: 23 },
    heading1: { color: theme.text, fontSize: 21, fontWeight: '700', marginTop: 10, marginBottom: 4 },
    heading2: { color: theme.text, fontSize: 19, fontWeight: '700', marginTop: 10, marginBottom: 4 },
    heading3: { color: theme.text, fontSize: 17, fontWeight: '700', marginTop: 8, marginBottom: 4 },
    paragraph: { marginTop: 0, marginBottom: 10 },
    link: { color: theme.accent, textDecorationLine: 'underline' },
    blockquote: {
      backgroundColor: 'transparent',
      borderLeftWidth: 3,
      borderLeftColor: theme.line,
      paddingLeft: 10,
      marginLeft: 0
    },
    hr: { backgroundColor: theme.line, height: StyleSheet.hairlineWidth },
    code_inline: { backgroundColor: theme.card, color: theme.text, borderWidth: 0, fontSize: 14 },
    // Code blocks scroll horizontally rather than wrap: a wrapped command line
    // is a command line you cannot copy correctly.
    code_block: { backgroundColor: theme.card, borderColor: theme.line, color: theme.text, fontSize: 13 },
    fence: { backgroundColor: theme.card, borderColor: theme.line, color: theme.text, fontSize: 13 },
    table: { borderColor: theme.line },
    tr: { borderColor: theme.line },
    th: { color: theme.text },
    td: { color: theme.text }
  });
  cache.set(theme, styles);
  return styles;
}

export function AgentMarkdown({ text, theme }: { text: string; theme: Theme }): ReactElement {
  return <Markdown style={markdownStyles(theme)}>{text}</Markdown>;
}
