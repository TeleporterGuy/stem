// The MDX renderer, tested headless.
//
// `react-native` cannot be imported by Node at all — it ships Flow source — so
// the module is replaced with string host types before anything under test loads
// it. That is enough, because nothing here renders: `renderMdx` returns a React
// element TREE, and every question worth asking of this pipeline is a question
// about that tree. Which component did a tag route to, with which props. What a
// compound component's parts look like from where the parent will go looking for
// them (collectByType walks elements, not a rendered output, so the assertions
// below exercise the real lookup). And, most of all, what happens to input the
// model got wrong: an unknown tag, an unclosed one, a half-arrived stream.
//
// Component internals that need hooks (a tab's selected index, a quiz's score)
// are not reachable without a renderer and a simulator, so their logic is
// factored into data.ts / collect.ts and tested there directly.

import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  Image: 'Image',
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'ios' },
  StyleSheet: { create: <T,>(s: T): T => s, hairlineWidth: 1, flatten: (s: unknown) => s }
}));

const { isValidElement } = await import('react');
const { renderMdx } = await import('../src/mdx/render');
const {
  Callout,
  Chart,
  Collapsible,
  DataTable,
  Form,
  FormField,
  MdxParagraph,
  Quiz,
  QuizChoice,
  QuizQuestion,
  Step,
  Steps,
  TabPanel,
  Tabs,
  TaskItem
} = await import('../src/mdx/components');
const { collectByType, nodeText } = await import('../src/mdx/collect');
const { componentTagName, splitMdBlocks, stripComponentTags } = await import('../src/mdx/parse');
const { barGeometry, parseSeries, parseTable, sortRows } = await import('../src/mdx/data');

type Node = ReturnType<typeof renderMdx>;

/** Every element in the tree, in document order. */
function elements(node: unknown, out: Array<{ type: unknown; props: Record<string, unknown> }> = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => elements(n, out));
    return out;
  }
  if (!isValidElement(node)) return out;
  const props = node.props as Record<string, unknown>;
  out.push({ type: node.type, props });
  elements(props.children, out);
  return out;
}

function findAll(tree: Node, type: unknown) {
  return elements(tree).filter((e) => e.type === type);
}

function findOne(tree: Node, type: unknown) {
  const hits = findAll(tree, type);
  expect(hits.length, `expected exactly one ${String((type as { name?: string })?.name ?? type)}`).toBe(1);
  return hits[0];
}

/** All the words a reader would see. */
function text(tree: Node): string {
  return nodeText(tree as never);
}

describe('markdown primitives', () => {
  it('renders headings, paragraphs and inline emphasis without losing words', () => {
    const tree = renderMdx('# Title\n\nSome **bold** and *soft* text.');
    expect(text(tree)).toContain('Title');
    expect(text(tree)).toContain('bold');
    expect(text(tree)).toContain('soft');
  });

  it('renders a fenced code block as its own element, not as a paragraph', () => {
    const tree = renderMdx('```sh\nnpm test\n```');
    const code = elements(tree).find((e) => (e.props as { value?: string }).value === 'npm test');
    expect(code).toBeDefined();
    expect(code?.props.lang).toBe('sh');
  });

  it('renders a GFM task list as tickable items', () => {
    const tree = renderMdx('- [ ] one\n- [x] two');
    const items = findAll(tree, TaskItem);
    expect(items.map((i) => i.props.checked)).toEqual([false, true]);
  });

  it('renders a GFM table with a header row', () => {
    const tree = renderMdx('| a | b |\n| - | - |\n| 1 | 2 |');
    const heads = elements(tree).filter((e) => e.props.head === true);
    expect(heads.length).toBeGreaterThan(0);
    expect(text(tree)).toContain('1');
  });

  it('drops a javascript: link but keeps its words', () => {
    const tree = renderMdx('[click me](javascript:alert(1))');
    expect(text(tree)).toContain('click me');
    expect(JSON.stringify(elements(tree).map((e) => e.props.href))).not.toContain('javascript');
  });
});

describe('component map', () => {
  it('routes <Callout> with its type attribute', () => {
    const tree = renderMdx('<Callout type="warn">\nMind the gap.\n</Callout>');
    expect(findOne(tree, Callout).props.type).toBe('warn');
    expect(text(tree)).toContain('Mind the gap.');
  });

  it('gives <Steps> its <Step>s, through the paragraph MDX wraps them in', () => {
    const tree = renderMdx('<Steps>\n<Step>Install it</Step>\n<Step>Run it</Step>\n</Steps>');
    const steps = findOne(tree, Steps);
    const parts = collectByType<{ children?: unknown }>(steps.props.children as never, Step);
    expect(parts).toHaveLength(2);
    expect(nodeText(parts[1] as never)).toContain('Run it');
  });

  it('routes <Collapsible> with its title and keeps the body for when it opens', () => {
    const tree = renderMdx('<Collapsible title="Why">\nBecause.\n</Collapsible>');
    const c = findOne(tree, Collapsible);
    expect(c.props.title).toBe('Why');
    expect(nodeText(c.props.children as never)).toContain('Because.');
  });

  it('gives <Tabs> its labelled panels', () => {
    const tree = renderMdx('<Tabs>\n<Tab label="first">one</Tab>\n<Tab label="second">two</Tab>\n</Tabs>');
    const tabs = findOne(tree, Tabs);
    const panels = collectByType<{ label?: string }>(tabs.props.children as never, TabPanel);
    expect(panels.map((p) => p.props.label)).toEqual(['first', 'second']);
  });

  it('hands <DataTable> the raw JSON of its code child, not its rendered children', () => {
    const tree = renderMdx('<DataTable caption="Sales">\n```json\n[{"q":"Q1","n":3}]\n```\n</DataTable>');
    const table = findOne(tree, DataTable);
    expect(table.props.caption).toBe('Sales');
    expect(parseTable(table.props.data as string)).toEqual({ columns: ['q', 'n'], rows: [{ q: 'Q1', n: 3 }] });
  });

  it('hands <Chart> its series and its type', () => {
    const tree = renderMdx('<Chart type="bar" title="Load">\n```json\n[{"label":"a","value":2}]\n```\n</Chart>');
    const chart = findOne(tree, Chart);
    expect(chart.props.type).toBe('bar');
    expect(chart.props.title).toBe('Load');
    expect(parseSeries(chart.props.data as string)).toEqual([{ label: 'a', value: 2 }]);
  });

  it('gives <Quiz> its questions and each question its choices', () => {
    const tree = renderMdx(
      '<Quiz topic="RN">\n<Question prompt="Two?" answer="yes">\n<Choice>yes</Choice>\n<Choice>no</Choice>\n</Question>\n</Quiz>'
    );
    const quiz = findOne(tree, Quiz);
    expect(quiz.props.topic).toBe('RN');
    const questions = collectByType<{ prompt?: string; answer?: string; children?: unknown }>(
      quiz.props.children as never,
      QuizQuestion
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].props.answer).toBe('yes');
    const choices = collectByType<{ children?: unknown }>(questions[0].props.children as never, QuizChoice);
    expect(choices.map((c) => nodeText(c as never).trim())).toEqual(['yes', 'no']);
  });

  it('gives <Form> its fields with their labels', () => {
    const tree = renderMdx(
      '<Form prompt="Where to?" submitLabel="Go">\n<Field name="city" label="City" />\n<Field name="when" label="When" type="number" />\n</Form>'
    );
    const form = findOne(tree, Form);
    expect(form.props.prompt).toBe('Where to?');
    const fields = collectByType<{ name?: string; label?: string; type?: string }>(
      form.props.children as never,
      FormField
    );
    expect(fields.map((f) => f.props.name)).toEqual(['city', 'when']);
    expect(fields[1].props.type).toBe('number');
  });
});

describe('the fallback rule', () => {
  it('renders an unknown component as its children rather than a blank', () => {
    const tree = renderMdx('<Sparkline series="1,2,3">\nA **spark** of hope.\n</Sparkline>');
    expect(text(tree)).toContain('A ');
    expect(text(tree)).toContain('spark');
    expect(text(tree)).toContain('of hope.');
    // No element carries the unknown tag: it is gone, its words are not.
    expect(elements(tree).some((e) => e.type === 'Sparkline')).toBe(false);
  });

  it('keeps a nested known component working inside an unknown one', () => {
    const tree = renderMdx('<Panel>\n<Callout type="info">\nStill here.\n</Callout>\n</Panel>');
    expect(findAll(tree, Callout)).toHaveLength(1);
    expect(text(tree)).toContain('Still here.');
  });

  it('degrades malformed MDX to plain Markdown instead of throwing', () => {
    const tree = renderMdx('<Callout type="info">\nAn **unclosed** thought');
    expect(text(tree)).toContain('unclosed');
    // The half-written tag is suppressed rather than shown as literal text.
    expect(text(tree)).not.toContain('<Callout');
  });

  it('survives input that is not markup at all', () => {
    for (const junk of ['<<<>>>', '{{{', '</Callout>', '<Callout {...spread}>x</Callout>', '']) {
      expect(() => renderMdx(junk)).not.toThrow();
    }
  });

  it('renders inert HTML as text and never as markup', () => {
    const tree = renderMdx('<script>alert(1)</script>');
    expect(elements(tree).some((e) => e.type === 'script')).toBe(false);
  });

  it('drops MDX expressions rather than evaluating them', () => {
    const tree = renderMdx('Value: {process.env.SECRET}\n');
    expect(text(tree)).toContain('Value:');
    expect(text(tree)).not.toContain('process.env');
  });

  it('still formats the words inside a tag that has not closed yet', () => {
    // The fallback path parses real Markdown, not the raw HTML block CommonMark
    // would otherwise make of an unclosed component.
    const tree = renderMdx('<Callout type="info">\nAn **unclosed** thought');
    const bold = elements(tree).find((e) => e.props.style === 'strong');
    expect(bold).toBeDefined();
    expect(nodeText(bold?.props.children as never)).toBe('unclosed');
  });

  it('strips component tags, complete or half-written, and nothing else', () => {
    expect(stripComponentTags('<Callout type="info">\nhi\n</Callout>')).toBe('\nhi\n');
    expect(stripComponentTags('a <Field name="x" /> b')).toBe('a  b');
    expect(stripComponentTags('tail <Callout type="in')).toBe('tail ');
    expect(stripComponentTags('a <b>bold</b> tag')).toBe('a <b>bold</b> tag');
  });

  it('recognises an in-flight component tag by its capital', () => {
    expect(componentTagName('<Callout type="info">')).toBe('Callout');
    expect(componentTagName('</Tabs>')).toBe('Tabs');
    expect(componentTagName('<div class="x">')).toBeNull();
  });
});

describe('streaming fragments', () => {
  it('splits on blank lines outside fenced code', () => {
    expect(splitMdBlocks('one\n\ntwo')).toEqual(['one', 'two']);
    expect(splitMdBlocks('```\na\n\nb\n```')).toEqual(['```\na\n\nb\n```']);
  });

  it('renders every prefix of a reply that ends mid-component', () => {
    const full = '# Report\n\n<Callout type="info">\nAlmost **done** now.\n</Callout>\n\nThe end.';
    for (let i = 1; i <= full.length; i++) {
      const partial = full.slice(0, i);
      expect(() => renderMdx(partial), `prefix of length ${i}`).not.toThrow();
      // A prefix that has reached the word must still be showing it.
      if (partial.includes('The end.')) expect(text(renderMdx(partial))).toContain('The end.');
    }
  });

  it('renders each streaming block on its own, the way the incremental view does', () => {
    const blocks = splitMdBlocks('# Report\n\n<Callout type="info">\nHalf a th');
    expect(blocks).toHaveLength(2);
    expect(text(renderMdx(blocks[0]))).toContain('Report');
    const tail = renderMdx(blocks[1]);
    expect(text(tail)).toContain('Half a th');
    expect(text(tail)).not.toContain('<Callout');
  });

  it('renders the completed text as real components once the tag closes', () => {
    const settled = renderMdx('<Callout type="info">\nHalf a thought.\n</Callout>');
    expect(findAll(settled, Callout)).toHaveLength(1);
  });
});

describe('table and chart data', () => {
  it('reads both accepted table shapes', () => {
    expect(parseTable('[{"a":1},{"b":2}]')?.columns).toEqual(['a', 'b']);
    expect(parseTable('{"columns":["a","b"],"rows":[[1,2]]}')).toEqual({
      columns: ['a', 'b'],
      rows: [{ a: 1, b: 2 }]
    });
    expect(parseTable('not json')).toBeNull();
    expect(parseTable(undefined)).toBeNull();
  });

  it('sorts numerically when both sides are numbers, alphabetically otherwise', () => {
    const rows = [{ n: 10, s: 'b' }, { n: 9, s: 'a' }];
    expect(sortRows(rows, 'n', 1).map((r) => r.n)).toEqual([9, 10]);
    expect(sortRows(rows, 'n', -1).map((r) => r.n)).toEqual([10, 9]);
    expect(sortRows(rows, 's', 1).map((r) => r.s)).toEqual(['a', 'b']);
  });

  it('drops non-numeric points and refuses an empty series', () => {
    expect(parseSeries('[{"label":"a","value":"x"},{"label":"b","value":1}]')).toEqual([{ label: 'b', value: 1 }]);
    expect(parseSeries('[]')).toBeNull();
  });

  it('gives a signed series one shared zero baseline', () => {
    const geo = barGeometry([
      { label: 'down', value: -5 },
      { label: 'up', value: 5 }
    ]);
    // Zero sits at the midpoint; each bar runs half the track from it.
    expect(geo[0].offset).toBeCloseTo(0);
    expect(geo[0].length).toBeCloseTo(0.5);
    expect(geo[1].offset).toBeCloseTo(0.5);
    expect(geo[1].length).toBeCloseTo(0.5);
  });
});

describe('collectByType', () => {
  it('sees through the wrappers the walker inserts, and no further', () => {
    const marker = () => null;
    const tree = renderMdx('<Tabs>\n<Tab label="a">x</Tab>\n</Tabs>\n\n<Tabs>\n<Tab label="b">y</Tab>\n</Tabs>');
    const [outer, second] = findAll(tree, Tabs);
    // Two independent tab sets, each seeing only its own panel.
    expect(collectByType(outer.props.children as never, TabPanel)).toHaveLength(1);
    expect(collectByType(second.props.children as never, TabPanel)).toHaveLength(1);
    expect(collectByType(tree as never, marker)).toHaveLength(0);
  });

  it('does not descend into a nested compound component', () => {
    const tree = renderMdx('<Tabs>\n<Tab label="outer">\n<Tabs>\n<Tab label="inner">z</Tab>\n</Tabs>\n</Tab>\n</Tabs>');
    const outer = findAll(tree, Tabs)[0];
    const panels = collectByType<{ label?: string }>(outer.props.children as never, TabPanel);
    expect(panels.map((p) => p.props.label)).toEqual(['outer']);
  });

  it('reads a paragraph wrapper as transparent', () => {
    const tree = renderMdx('<Callout type="info">\nplain words\n</Callout>');
    const callout = findOne(tree, Callout);
    expect(findAll(callout.props.children as never, MdxParagraph).length).toBeGreaterThan(0);
    expect(nodeText(callout.props.children as never)).toContain('plain words');
  });
});
