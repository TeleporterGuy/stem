import { Fragment, memo, useRef, type ReactNode } from 'react';
import { renderMdx, splitMdBlocks } from '../mdx/render';

// Incremental renderer for a still-streaming Markdown reply. MdxView re-parses the
// entire accumulated text on every delta — O(n) per token, O(n²) per reply. Here the
// text is split into top-level blocks; in an append-only stream every block except
// the trailing one is final, so each is parsed once and cached. Only the growing
// tail re-parses per update. ChatView swaps back to MdxView (exact full parse) the
// moment the message settles, so any block-split artifacts are transient.
export const StreamingMdxView = memo(function StreamingMdxView({ text }: { text: string }) {
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
    // Mismatch (shouldn't happen for an append-only stream, but a re-mount or an
    // edited message must not render stale nodes): drop everything from here on.
    cache.current.length = i;
    const node = <Fragment key={`b-${i}`}>{renderMdx(blocks[i])}</Fragment>;
    cache.current[i] = { text: blocks[i], node };
    nodes.push(node);
  }
  if (cache.current.length > stableCount) cache.current.length = stableCount;
  const tail =
    blocks.length > 0 ? (
      <Fragment key={`tail-${stableCount}`}>{renderMdx(blocks[blocks.length - 1])}</Fragment>
    ) : null;
  return (
    <div className="mdx">
      {nodes}
      {tail}
    </div>
  );
});
