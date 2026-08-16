// The front half of the MDX pipeline: text in, mdast out.
//
// Deliberately free of React and of React Native. Two reasons, and the second is
// the one that shaped the file: the same parse has to run on a phone and in a
// headless vitest process, and `react-native` cannot even be imported by Node
// (it ships Flow source). Everything that can be decided without a view — is the
// MDX well-formed, where do the streaming block boundaries fall, which URL
// schemes are allowed — is decided here, and is testable as plain functions.
//
// The processors are the desktop's, package for package (src/renderer/mdx/
// render.tsx): unified + remark-parse + remark-gfm + remark-mdx, all pure JS, no
// native module, so no dev-client rebuild. Agreeing on the parser is what makes
// "the same answer renders the same on both screens" true rather than hoped for.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';

/** A minimal structural type for the mdast/mdx nodes the renderer walks. */
export interface MdNode {
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

export interface ParsedMdx {
  tree: MdNode;
  /** False when MDX parsing failed and this is the plain-Markdown fallback. */
  mdx: boolean;
}

/**
 * Parse the safe MDX subset, degrading rather than failing. MDX first, so
 * component tags are recognised; plain Markdown second, because a half-written
 * tag mid-stream (or a model that miscounted its brackets) is a routine event
 * and must still produce a readable answer; null last, for the caller to render
 * as literal text. Never executes model code — this is `parse`, not `run`.
 */
export function parseMdx(text: string): ParsedMdx | null {
  try {
    return { tree: mdxProcessor.parse(text) as unknown as MdNode, mdx: true };
  } catch {
    /* malformed JSX — fall through to plain Markdown */
  }
  try {
    return { tree: plainProcessor.parse(stripComponentTags(text)) as unknown as MdNode, mdx: false };
  } catch {
    return null;
  }
}

/** A component tag, opening or closing, complete or still being written. */
const COMPONENT_TAG = /<\/?[A-Z][A-Za-z0-9]*(?:\s[^<>]*?)?\/?>/g;
const COMPONENT_TAG_TAIL = /<\/?[A-Z][A-Za-z0-9]*(?:\s[^<>]*)?$/;

/**
 * Remove component tags from the source, for the plain-Markdown fallback only.
 *
 * The case this exists for is every reply that uses a component, once per
 * delta: `<Callout type="info">\nMind the` fails MDX parsing until the closing
 * tag arrives, and CommonMark reads the whole thing as one HTML block, so
 * rendering the fallback verbatim would show the reader the literal tag AND
 * would show the sentence inside it as unformatted markup. Dropping the tags
 * first leaves the sentence, correctly formatted, which is what the reader was
 * promised. Stem's vocabulary is capitalised and HTML's is not, so the initial
 * capital identifies a component tag and leaves real inline HTML alone.
 */
export function stripComponentTags(text: string): string {
  return text.replace(COMPONENT_TAG, '').replace(COMPONENT_TAG_TAIL, '');
}

/** Only allow safe URL schemes; everything else (e.g. javascript:) is dropped. */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(url)) return url;
  if (/^data:image\//i.test(url)) return url;
  return undefined;
}

/** Extract plain string-valued JSX attributes; expression-valued attrs are ignored. */
export function stringAttributes(node: MdNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of node.attributes ?? []) {
    if (attr.type === 'mdxJsxAttribute' && typeof attr.name === 'string' && typeof attr.value === 'string') {
      out[attr.name] = attr.value;
    }
  }
  return out;
}

/**
 * The tag name of a raw-HTML node that is really an in-flight component tag.
 *
 * Only reachable through the plain-Markdown fallback: MDX parsing of
 * `<Callout type="info">` with no closing tag yet throws, the fallback parses
 * the same characters as an HTML node, and rendering it inert would flash the
 * literal `<Callout type="info">` at the reader for as long as the model takes
 * to close it. Stem's component vocabulary is capitalised and HTML's is not, so
 * an initial capital identifies the case exactly.
 */
export function componentTagName(raw: string | undefined): string | null {
  const m = /^<\/?\s*([A-Z][A-Za-z0-9]*)/.exec((raw ?? '').trim());
  return m ? m[1] : null;
}

/** mdast phrasing (inline) content, which on RN must live inside a <Text>. */
const PHRASING = new Set([
  'text',
  'emphasis',
  'strong',
  'delete',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'break',
  'footnoteReference',
  'html',
  'mdxJsxTextElement',
  'mdxTextExpression'
]);

export function isPhrasing(node: MdNode): boolean {
  return PHRASING.has(node.type);
}

/**
 * Split markdown into top-level blocks: boundary = blank line outside a fenced
 * code block. Backs the streaming view's incremental parse — in an append-only
 * stream every block except the last is final, so it's parsed exactly once.
 * Approximate on purpose (a loose list or table split by blank lines renders as
 * separate blocks until completion); the settled message re-renders via the
 * exact full parse, healing any transient artifacts.
 *
 * Ported verbatim from src/renderer/mdx/render.tsx — same stream, same rule.
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
