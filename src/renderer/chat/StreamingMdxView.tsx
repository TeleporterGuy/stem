import { Fragment, memo, useRef, type ReactNode } from 'react';
import { provisionalTail, renderMdx, splitStreamBlocks, streamingData, tryRenderMdx } from '../mdx/render';
import { MdxPlaceholder, componentMap } from '../mdx/components';
import { completeRows } from '../mdx/data';
import { Diagram } from '../mdx/Diagram';

// Incremental renderer for a still-streaming reply. MdxView re-parses the entire
// accumulated text on every delta — O(n) per token, O(n²) per reply. Here the text
// is split into top-level blocks; in an append-only stream every block except the
// trailing one is final, so each is parsed once and cached. Only the growing tail
// re-parses per update. ChatView swaps back to MdxView (exact full parse) the
// moment the message settles, so any block-split artifacts are transient.
//
// The splitter keeps a component spanning blank lines in one block and says
// which component the tail is still inside. Prose containers (Callout, Steps,
// Tabs…) render live, closed provisionally; anything whose content is data
// (Chart, DataTable, Quiz, Form…) shows a placeholder until its closing tag
// arrives. A half-written tag is never shown as text. Diagrams and the JSON
// data components are the exception: a Diagram draws line by line, and a
// Chart, DataTable, Stats or Compare row by row, as their data arrives.
export const StreamingMdxView = memo(function StreamingMdxView({ text }: { text: string }) {
  const cache = useRef<Array<{ text: string; node: ReactNode }>>([]);
  const blocks = splitStreamBlocks(text);
  const stableCount = Math.max(0, blocks.length - 1);
  const nodes: ReactNode[] = [];
  for (let i = 0; i < stableCount; i++) {
    const cached = cache.current[i];
    if (cached && cached.text === blocks[i].text) {
      nodes.push(cached.node);
      continue;
    }
    // Mismatch (shouldn't happen for an append-only stream, but a re-mount or an
    // edited message must not render stale nodes): drop everything from here on.
    cache.current.length = i;
    const node = <Fragment key={`b-${i}`}>{renderMdx(blocks[i].text)}</Fragment>;
    cache.current[i] = { text: blocks[i].text, node };
    nodes.push(node);
  }
  if (cache.current.length > stableCount) cache.current.length = stableCount;
  let tail: ReactNode = null;
  const last = blocks[blocks.length - 1];
  const data = last && streamingData(last);
  if (data) tail = <Fragment key={`tail-${stableCount}`}>{liveData(data)}</Fragment>;
  else if (last) {
    const { live, pending } = provisionalTail(last);
    let liveNode: ReactNode = null;
    let waiting = pending;
    if (live.trim()) {
      // A provisionally closed tail that still doesn't parse waits as a
      // placeholder rather than falling back to tags-as-text.
      liveNode = last.open === null ? renderMdx(live) : tryRenderMdx(live);
      if (liveNode === null) waiting = last.open ?? '';
    }
    tail = (
      <Fragment key={`tail-${stableCount}`}>
        {liveNode}
        {waiting !== null && <MdxPlaceholder name={waiting} />}
      </Fragment>
    );
  }
  return (
    <div className="mdx">
      {nodes}
      {tail}
    </div>
  );
});

/** A data component drawn from what has arrived so far; a placeholder until its first row. */
function liveData({ name, props, value, closed }: NonNullable<ReturnType<typeof streamingData>>): ReactNode {
  // A closed fence's last line is complete, so it counts.
  if (name === 'Diagram') return <Diagram live title={props.title} source={closed ? `${value}\n` : value} />;
  const rows = closed ? value : completeRows(value);
  return rows ? componentMap[name](props, null, { value: rows }) : <MdxPlaceholder name={name} />;
}
