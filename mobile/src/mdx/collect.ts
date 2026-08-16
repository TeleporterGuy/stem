// How a compound component finds its own parts.
//
// <Tabs> needs its <Tab>s, <Quiz> its <Question>s, <Form> its <Field>s — and the
// parser is no help: by the time a component function runs, its parts are React
// elements in `children`, not AST nodes. So the parent introspects the rendered
// tree, exactly as the desktop does (src/renderer/mdx/components.tsx).
//
// The descent list is the part worth reading twice. Between a parent and its
// markers the walker inserts wrappers — a keyed Fragment around every component
// result, and a paragraph whenever MDX put the parts on consecutive lines
// (`<Tab label="a">x</Tab>` on its own line parses as INLINE content, so a
// paragraph wraps the lot). Those three are transparent. Anything else is not:
// descending into another component would let a nested <Tabs> steal the outer
// one's tabs, so the walk stops at every element it does not recognise.

import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';

/** Wrappers the walker inserts that a parent may see through. Set by render.tsx. */
const transparent = new Set<unknown>([Fragment]);

/** Register a wrapper component as see-through for collectByType. */
export function markTransparent(...types: unknown[]): void {
  for (const t of types) transparent.add(t);
}

/** Find all marker children of a given component type, without recursing into them. */
export function collectByType<P>(children: ReactNode, type: unknown): ReactElement<P>[] {
  const out: ReactElement<P>[] = [];
  const visit = (nodes: ReactNode): void => {
    Children.toArray(nodes).forEach((c) => {
      if (!isValidElement(c)) return;
      if (c.type === type) {
        out.push(c as ReactElement<P>);
        return;
      }
      if (transparent.has(c.type)) visit((c.props as { children?: ReactNode }).children);
    });
  };
  visit(children);
  return out;
}

/**
 * Flatten a ReactNode to its plain text — used to read a quiz choice's label and
 * compare it against its question's `answer`. Descends everything, including
 * components: the goal here is the words a reader sees, not structure.
 */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}
