import type { ReactNode } from 'react';
import { Fragment, createElement } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import { stripCiteMarkers } from '../../shared/citations';
import { CodeBlock, TaskItem, componentMap } from './components';

// A minimal structural type for the mdast/mdx nodes we walk.
interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  checked?: boolean | null;
  url?: string;
  alt?: string;
  lang?: string;
  name?: string | null;
  attributes?: Array<{ type: string; name?: string; value?: unknown }>;
  children?: MdNode[];
}

const mdxProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);
const plainProcessor = unified().use(remarkParse).use(remarkGfm);

/** Only allow safe URL schemes; everything else (e.g. javascript:) is dropped. */
function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(url)) return url;
  if (/^data:image\//i.test(url)) return url;
  return undefined;
}

/** Extract plain string-valued JSX attributes; expression-valued attrs are ignored. */
function stringAttributes(node: MdNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of node.attributes ?? []) {
    if (attr.type === 'mdxJsxAttribute' && typeof attr.name === 'string' && typeof attr.value === 'string') {
      out[attr.name] = attr.value;
    }
  }
  return out;
}

function renderChildren(node: MdNode, keyPrefix: string): ReactNode[] {
  return (node.children ?? []).map((child, i) => renderNode(child, `${keyPrefix}-${i}`));
}

function renderNode(node: MdNode, key: string): ReactNode {
  switch (node.type) {
    case 'root':
      return <Fragment key={key}>{renderChildren(node, key)}</Fragment>;
    case 'paragraph':
      return <p key={key}>{renderChildren(node, key)}</p>;
    case 'text':
      return node.value ?? '';
    case 'heading': {
      const tag = `h${Math.min(Math.max(node.depth ?? 1, 1), 6)}`;
      return createElement(tag, { key }, renderChildren(node, key));
    }
    case 'strong':
      return <strong key={key}>{renderChildren(node, key)}</strong>;
    case 'emphasis':
      return <em key={key}>{renderChildren(node, key)}</em>;
    case 'delete':
      return <del key={key}>{renderChildren(node, key)}</del>;
    case 'inlineCode':
      return <code key={key} className="inline-code">{node.value}</code>;
    case 'code':
      return <CodeBlock key={key} lang={node.lang ?? undefined} value={node.value ?? ''} />;
    case 'list': {
      // GFM task lists mark items with `checked`; the list itself drops its
      // bullets so the checkboxes become the markers.
      const task = (node.children ?? []).some((c) => typeof c.checked === 'boolean');
      const className = task ? 'task-list' : undefined;
      return node.ordered
        ? <ol key={key} className={className}>{renderChildren(node, key)}</ol>
        : <ul key={key} className={className}>{renderChildren(node, key)}</ul>;
    }
    case 'listItem':
      return typeof node.checked === 'boolean'
        ? <TaskItem key={key} checked={node.checked}>{renderChildren(node, key)}</TaskItem>
        : <li key={key}>{renderChildren(node, key)}</li>;
    case 'link': {
      const href = safeUrl(node.url);
      return href
        ? <a key={key} href={href} target="_blank" rel="noreferrer">{renderChildren(node, key)}</a>
        : <Fragment key={key}>{renderChildren(node, key)}</Fragment>;
    }
    case 'image': {
      const src = safeUrl(node.url);
      return src ? <img key={key} src={src} alt={node.alt ?? ''} /> : <Fragment key={key}>{node.alt ?? ''}</Fragment>;
    }
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node, key)}</blockquote>;
    case 'thematicBreak':
      return <hr key={key} />;
    case 'break':
      return <br key={key} />;
    case 'table':
      return <table key={key}><tbody>{renderChildren(node, key)}</tbody></table>;
    case 'tableRow':
      return <tr key={key}>{renderChildren(node, key)}</tr>;
    case 'tableCell':
      return <td key={key}>{renderChildren(node, key)}</td>;

    // MDX components: only render allow-listed ones; others become inert text.
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement': {
      const name = typeof node.name === 'string' ? node.name : '';
      const entry = componentMap[name];
      const children = <Fragment key={`${key}-c`}>{renderChildren(node, key)}</Fragment>;
      if (entry) {
        // Data-heavy components (Chart/DataTable) read their payload from a fenced
        // code child (e.g. ```json …```). We surface its RAW text so the component
        // can JSON.parse it — this never executes model code, it's just data.
        const dataChild = (node.children ?? []).find((c) => c.type === 'code');
        const data = dataChild
          ? { lang: dataChild.lang ?? undefined, value: dataChild.value ?? '' }
          : undefined;
        return <Fragment key={key}>{entry(stringAttributes(node), children, data)}</Fragment>;
      }
      // Unknown component (e.g. <script>): drop the tag, keep children as text.
      return children;
    }

    // Security: never execute model JS or imports.
    case 'mdxFlowExpression':
    case 'mdxTextExpression':
    case 'mdxjsEsm':
      return null;

    // Raw HTML is rendered inert (as escaped text), never as live markup.
    case 'html':
      return <span key={key}>{node.value ?? ''}</span>;

    default:
      return node.children ? <Fragment key={key}>{renderChildren(node, key)}</Fragment> : (node.value ?? null);
  }
}

/**
 * Split markdown into top-level blocks: boundary = blank line outside a fenced
 * code block. Backs StreamingMdxView's incremental parse — in an append-only
 * stream every block except the last is final, so it's parsed exactly once.
 * Approximate on purpose (a loose list or table split by blank lines renders as
 * separate blocks until completion); the settled message re-renders via the
 * exact full parse, healing any transient artifacts.
 */
export function splitMdBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null; // the opening fence marker (``` or ~~~, possibly longer)
  for (const line of text.split('\n')) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      current.push(line);
      // Closing fence: same char, at least as long, nothing else on the line.
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      if (current.length) {
        blocks.push(current.join('\n'));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}

/**
 * Parse the safe MDX subset and render it to React. Tries MDX parsing first
 * (to recognize component tags); if the model emitted malformed JSX, falls back
 * to plain Markdown so the answer still renders. Never executes model code.
 * Leaked web-search citation markers are stripped here rather than per delta —
 * a marker can split across delta boundaries, but the accumulated text passed
 * in always contains it whole (or as a strippable unterminated tail).
 */
export function renderMdx(text: string): ReactNode {
  text = stripCiteMarkers(text);
  let tree: MdNode;
  try {
    tree = mdxProcessor.parse(text) as unknown as MdNode;
  } catch {
    try {
      tree = plainProcessor.parse(text) as unknown as MdNode;
    } catch {
      return <p>{text}</p>;
    }
  }
  return renderNode(tree, 'mdx');
}
