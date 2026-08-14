// The two ways a reply gets on screen, and the net under both of them.
//
// MdxView is the settled message: one exact parse of the whole text, memoised so
// a re-render that changed nothing re-parses nothing.
//
// StreamingMdxView is the same text while it is still arriving. Re-parsing the
// whole reply on every delta is O(n) per token and O(n²) per reply, which a
// laptop absorbs and a phone does not, so the text is split into top-level blocks
// and only the growing tail is re-parsed; in an append-only stream every earlier
// block is final. The split is approximate (splitMdBlocks' own comment says so),
// which is exactly why the settled message must go back through MdxView — the
// full parse heals any block-split artifact the moment the turn ends. That
// hand-off is the desktop's, from src/renderer/chat/StreamingMdxView.tsx.
//
// MdxBoundary is the net. React Native has no default error boundary, so a throw
// inside a component takes down the screen, not the bubble — and the input here
// is model output, which is to say arbitrary. A failed render falls back to the
// raw text, and resets the moment the text changes, so a fragment that breaks
// mid-stream comes right when the next delta lands.

import { Component, Fragment, memo, useMemo, useRef, type ReactNode } from 'react';
import { Text } from 'react-native';
import type { Theme } from '../ui/theme';
import { splitMdBlocks } from './parse';
import { renderMdx } from './render';
import { MdxKitProvider, mdxKit, useMdxKit } from './styles';

function PlainText({ text }: { text: string }): ReactNode {
  const { s } = useMdxKit();
  return <Text style={s.paragraph}>{text}</Text>;
}

class MdxBoundary extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(prev: { text: string }): void {
    if (this.state.failed && prev.text !== this.props.text) this.setState({ failed: false });
  }

  render(): ReactNode {
    return this.state.failed ? <PlainText text={this.props.text} /> : this.props.children;
  }
}

export const MdxView = memo(function MdxView({ text, theme }: { text: string; theme: Theme }): ReactNode {
  const body = useMemo(() => renderMdx(text), [text]);
  return (
    <MdxKitProvider value={mdxKit(theme)}>
      <MdxBoundary text={text}>{body}</MdxBoundary>
    </MdxKitProvider>
  );
});

export const StreamingMdxView = memo(function StreamingMdxView({
  text,
  theme
}: {
  text: string;
  theme: Theme;
}): ReactNode {
  const cache = useRef<Array<{ text: string; node: ReactNode }>>([]);
  const blocks = splitMdBlocks(text);
  const stableCount = Math.max(0, blocks.length - 1);
  const nodes: ReactNode[] = [];
  for (let i = 0; i < stableCount; i++) {
    const cached = cache.current[i];
    if (cached && cached.text === blocks[i]) {
      nodes.push(cached.node);
      continue;
    }
    // Mismatch (it should not happen for an append-only stream, but a re-mount or
    // an edited message must not render stale nodes): drop everything from here on.
    cache.current.length = i;
    const node = <Fragment key={`b-${i}`}>{renderMdx(blocks[i])}</Fragment>;
    cache.current[i] = { text: blocks[i], node };
    nodes.push(node);
  }
  if (cache.current.length > stableCount) cache.current.length = stableCount;
  const tail = blocks.length > 0 ? <Fragment key={`tail-${stableCount}`}>{renderMdx(blocks[blocks.length - 1])}</Fragment> : null;
  return (
    <MdxKitProvider value={mdxKit(theme)}>
      <MdxBoundary text={text}>
        {nodes}
        {tail}
      </MdxBoundary>
    </MdxKitProvider>
  );
});
