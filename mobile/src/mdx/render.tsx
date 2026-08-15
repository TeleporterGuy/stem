// The walker: mdast in, React Native elements out.
//
// It is the desktop's src/renderer/mdx/render.tsx with one structural difference
// forced by the platform. On the web a renderer can emit `<p>` and `<div>` in any
// order and the browser sorts it out; React Native has two worlds — text lives
// inside <Text>, boxes live inside <View>, and a <View> nested in a <Text> is a
// layout bug. So the walk is split in two:
//
//   renderFlow      block sequence: headings, lists, code, components. Runs of
//                   inline content between them are gathered into a paragraph.
//   renderPhrasing  inline content, always destined for a <Text>.
//
// The one subtlety worth knowing before changing anything here: MDX parses
// `<Tab label="a">x</Tab>` written on its own line as INLINE content, so the
// three consecutive <Tab>s of a tab set arrive as mdxJsxTextElements inside a
// single paragraph. A paragraph holding component tags is therefore re-read as
// flow rather than wrapped in a <Text> — otherwise every compound component
// would render its Views inside a Text and lay out wrong.
//
// Security is the desktop's, unchanged: expressions and ESM are dropped rather
// than evaluated, raw HTML is inert text, URLs are scheme-checked, and only the
// allow-listed component names are ever instantiated. Unknown tags render their
// children — the fallback rule that makes a new component on the server side a
// degraded reading experience on an old phone rather than a blank bubble.

import { Fragment, type ReactNode } from 'react';
import { Image, Linking, Text, View } from 'react-native';
import { stripCiteMarkers } from '@shared/citations';
import {
  CodeBlock,
  MdxGroup,
  MdxParagraph,
  MdxTable,
  MdxTableCell,
  MdxTableRow,
  TaskItem,
  componentMap
} from './components';
import { componentTagName, isPhrasing, parseMdx, safeUrl, stringAttributes, type MdNode } from './parse';
import { useMdxKit } from './styles';

function isComponentTag(node: MdNode): boolean {
  return (
    (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') &&
    typeof node.name === 'string' &&
    node.name in componentMap
  );
}

function isBlank(node: MdNode): boolean {
  return node.type === 'text' && !(node.value ?? '').trim();
}

// ---- inline ----------------------------------------------------------------

function LinkText({ href, children }: { href: string; children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return (
    <Text style={s.link} onPress={() => void Linking.openURL(href).catch(() => undefined)}>
      {children}
    </Text>
  );
}

function StyledText({ style, children }: { style: 'strong' | 'emphasis' | 'strike'; children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return <Text style={s[style]}>{children}</Text>;
}

function InlineCode({ value }: { value: string }): ReactNode {
  const { s } = useMdxKit();
  return <Text style={s.inlineCode}>{value}</Text>;
}

function renderPhrasing(nodes: MdNode[], key: string): ReactNode[] {
  return nodes.map((node, i) => renderInline(node, `${key}-${i}`));
}

function renderInline(node: MdNode, key: string): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value ?? '';
    case 'strong':
      return <StyledText key={key} style="strong">{renderPhrasing(node.children ?? [], key)}</StyledText>;
    case 'emphasis':
      return <StyledText key={key} style="emphasis">{renderPhrasing(node.children ?? [], key)}</StyledText>;
    case 'delete':
      return <StyledText key={key} style="strike">{renderPhrasing(node.children ?? [], key)}</StyledText>;
    case 'inlineCode':
      return <InlineCode key={key} value={node.value ?? ''} />;
    case 'link': {
      const href = safeUrl(node.url);
      const children = renderPhrasing(node.children ?? [], key);
      return href ? <LinkText key={key} href={href}>{children}</LinkText> : <Fragment key={key}>{children}</Fragment>;
    }
    // An image inside a sentence has nowhere to go on RN (<Image> cannot live in
    // a <Text>), so it reads as its alt text. A picture on its own line is
    // rendered for real — see renderFlow.
    case 'image':
      return node.alt ?? '';
    case 'break':
      return '\n';
    case 'html':
      // Inert, and silent when it is really a component tag the stream has not
      // finished writing (see componentTagName).
      return componentTagName(node.value) ? null : (node.value ?? '');
    case 'mdxTextExpression':
    case 'mdxFlowExpression':
    case 'mdxjsEsm':
      return null;
    case 'mdxJsxTextElement':
      // Reached only for a tag inside a sentence; the block-level case is lifted
      // out by renderFlow. Keep the words, drop the tag.
      return <Fragment key={key}>{renderPhrasing(node.children ?? [], key)}</Fragment>;
    default:
      return node.children ? <Fragment key={key}>{renderPhrasing(node.children, key)}</Fragment> : (node.value ?? '');
  }
}

// ---- blocks ----------------------------------------------------------------

function Heading({ depth, children }: { depth: number; children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  const style = depth <= 1 ? s.heading1 : depth === 2 ? s.heading2 : s.heading3;
  return <Text style={style}>{children}</Text>;
}

function Blockquote({ children }: { children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return <View style={s.blockquote}>{children}</View>;
}

function Rule(): ReactNode {
  const { s } = useMdxKit();
  return <View style={s.rule} />;
}

function ListBlock({ children }: { children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return <View style={s.list}>{children}</View>;
}

function ListItem({ marker, children }: { marker: string; children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return (
    <View style={s.listItem}>
      <Text style={s.listMarker}>{marker}</Text>
      <View style={s.listBody}>{children}</View>
    </View>
  );
}

function BlockImage({ uri }: { uri: string }): ReactNode {
  const { s } = useMdxKit();
  return <Image source={{ uri }} style={s.image} resizeMode="contain" />;
}

/**
 * A block sequence. Consecutive inline nodes are gathered into one paragraph;
 * whitespace-only runs (the newlines MDX leaves between sibling tags) are
 * dropped rather than becoming empty lines.
 */
function renderFlow(nodes: MdNode[], key: string, compact = false): ReactNode[] {
  const out: ReactNode[] = [];
  let run: MdNode[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const gathered = run;
    run = [];
    if (gathered.every(isBlank)) return;
    const at = `${key}-p${out.length}`;
    out.push(
      <MdxParagraph key={at} style={compact ? { marginBottom: 0 } : undefined}>
        {renderPhrasing(gathered, at)}
      </MdxParagraph>
    );
  };

  nodes.forEach((node, i) => {
    const at = `${key}-${i}`;
    if (node.type === 'paragraph') {
      const children = node.children ?? [];
      flush();
      // A paragraph is only a paragraph if it holds no component tags and is not
      // a lone picture; both of those are blocks wearing a paragraph's clothes.
      if (children.some(isComponentTag)) {
        out.push(...renderFlow(children, at, compact));
        return;
      }
      const solid = children.filter((c) => !isBlank(c));
      if (solid.length === 1 && solid[0].type === 'image') {
        const uri = safeUrl(solid[0].url);
        if (uri) {
          out.push(<BlockImage key={at} uri={uri} />);
          return;
        }
      }
      out.push(
        <MdxParagraph key={at} style={compact ? { marginBottom: 0 } : undefined}>
          {renderPhrasing(children, at)}
        </MdxParagraph>
      );
      return;
    }
    if (isPhrasing(node) && !isComponentTag(node)) {
      run.push(node);
      return;
    }
    flush();
    out.push(renderBlock(node, at));
  });
  flush();
  return out;
}

function renderBlock(node: MdNode, key: string): ReactNode {
  switch (node.type) {
    case 'root':
      return <Fragment key={key}>{renderFlow(node.children ?? [], key)}</Fragment>;
    case 'heading':
      return (
        <Heading key={key} depth={node.depth ?? 1}>
          {renderPhrasing(node.children ?? [], key)}
        </Heading>
      );
    case 'blockquote':
      return <Blockquote key={key}>{renderFlow(node.children ?? [], key)}</Blockquote>;
    case 'thematicBreak':
      return <Rule key={key} />;
    case 'code':
      return <CodeBlock key={key} lang={node.lang ?? undefined} value={node.value ?? ''} />;
    case 'list': {
      const items = node.children ?? [];
      return (
        <ListBlock key={key}>
          {items.map((item, i) => {
            const body = renderFlow(item.children ?? [], `${key}-${i}`, true);
            return typeof item.checked === 'boolean' ? (
              <TaskItem key={i} checked={item.checked}>
                {body}
              </TaskItem>
            ) : (
              <ListItem key={i} marker={node.ordered ? `${i + 1}.` : '•'}>
                {body}
              </ListItem>
            );
          })}
        </ListBlock>
      );
    }
    case 'table': {
      const rows = node.children ?? [];
      return (
        <MdxTable key={key}>
          {rows.map((row, ri) => (
            <MdxTableRow key={ri} head={ri === 0}>
              {(row.children ?? []).map((cell, ci) => (
                <MdxTableCell key={ci} head={ri === 0}>
                  {renderPhrasing(cell.children ?? [], `${key}-${ri}-${ci}`)}
                </MdxTableCell>
              ))}
            </MdxTableRow>
          ))}
        </MdxTable>
      );
    }

    // MDX components: only allow-listed names are instantiated; everything else
    // renders its children, so a tag this build has never heard of costs the
    // reader its styling and nothing else.
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement': {
      const name = typeof node.name === 'string' ? node.name : '';
      const entry = componentMap[name];
      const children = <Fragment key={`${key}-c`}>{renderFlow(node.children ?? [], key)}</Fragment>;
      if (!entry) return children;
      // Data-heavy components (Chart/DataTable) read their payload from a fenced
      // code child. We hand over its RAW text so the component can JSON.parse it
      // — that is data, never executed.
      const dataChild = (node.children ?? []).find((c) => c.type === 'code');
      const data = dataChild ? { lang: dataChild.lang ?? undefined, value: dataChild.value ?? '' } : undefined;
      return <Fragment key={key}>{entry(stringAttributes(node), children, data)}</Fragment>;
    }

    case 'mdxFlowExpression':
    case 'mdxTextExpression':
    case 'mdxjsEsm':
      return null;

    case 'html':
      return componentTagName(node.value) ? null : (
        <MdxParagraph key={key}>{node.value ?? ''}</MdxParagraph>
      );

    // definition / footnoteDefinition and anything else with children: keep the
    // words rather than dropping the node.
    default:
      return node.children ? <MdxGroup key={key}>{renderFlow(node.children, key)}</MdxGroup> : null;
  }
}

/**
 * Parse the safe MDX subset and render it. Malformed JSX falls back to plain
 * Markdown, and unparseable text to itself, so there is no input for which this
 * returns nothing. Leaked web-search citation markers are stripped here rather
 * than per delta — a marker can split across delta boundaries, but the
 * accumulated text passed in always contains it whole (or as a strippable tail).
 */
export function renderMdx(text: string): ReactNode {
  const stripped = stripCiteMarkers(text);
  const parsed = parseMdx(stripped);
  if (!parsed) return <MdxParagraph>{stripped}</MdxParagraph>;
  return renderBlock(parsed.tree, 'mdx');
}
