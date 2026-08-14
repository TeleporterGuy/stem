// The React Native half of Stem's MDX component vocabulary.
//
// The desktop's src/renderer/mdx/components.tsx is the specification; this is the
// same components, same attribute names, same allow-list, expressed in Views and
// Texts. What is NOT re-decided here is which tags exist — the model is told one
// vocabulary and both screens must answer to it, so `componentMap` at the bottom
// mirrors the desktop's key for key.
//
// Two rules run through every component:
//
//   NEVER A BLANK. A component whose data will not parse shows the raw block and
//   says so; a component with no recognisable parts shows its children. The
//   reader's answer is never worse for having been marked up.
//
//   NEVER MODEL CODE. Attributes are strings, payloads are JSON.parse'd, and
//   nothing on this page can start a turn except a real finger on a real button
//   (see actions.ts). The MDX expression nodes are dropped by the walker before
//   they reach this file.
//
// Deviations from the desktop, all of them phone-shaped and deliberate:
//   - <Chart> draws bars out of Views. Line and area series are drawn as bars
//     too. Proper axes need react-native-svg, which is a native module and so a
//     dev-build-era change; a bar per point is honest about the data today.
//   - <DataTable> sorts by tapping a header but has no filter box: a text field
//     inside a scrolling transcript competes with the composer for the keyboard.
//     Long tables are capped, with the count of what was left out.
//   - <CodeBlock> has no copy button (expo-clipboard is another native module).

import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, TextInput, View, type StyleProp, type TextStyle } from 'react-native';
import { useMdxActions } from './actions';
import { collectByType, markTransparent, nodeText } from './collect';
import {
  barGeometry,
  cellText,
  formatValue,
  parseSeries,
  parseTable,
  sortRows,
  type Row
} from './data';
import { useMdxKit } from './styles';

/** Rows shown before a table is truncated — a phone transcript, not a spreadsheet. */
const MAX_TABLE_ROWS = 30;

// ---- Wrappers the walker emits, and which parents may see through ----------

/** A run of inline content. Every string the renderer produces lands in one. */
export function MdxParagraph({
  children,
  style
}: {
  children?: ReactNode;
  style?: StyleProp<TextStyle>;
}): ReactNode {
  const { s } = useMdxKit();
  return <Text style={[s.paragraph, style]}>{children}</Text>;
}

/** A run of block content: list item bodies, component children, quiz answers. */
export function MdxGroup({ children }: { children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return <View style={s.group}>{children}</View>;
}

markTransparent(MdxParagraph, MdxGroup);

// ---- Primitives the walker instantiates ------------------------------------

export function CodeBlock({ lang, value }: { lang?: string; value: string }): ReactNode {
  const { s } = useMdxKit();
  return (
    <View style={s.codeBlock}>
      {lang ? <Text style={s.codeLang}>{lang}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.codeScroll}>
        <Text style={s.codeText}>{value}</Text>
      </ScrollView>
    </View>
  );
}

/**
 * A GFM `- [ ]` item. The marker in the text sets the initial state; ticking is
 * local so the reader can track progress — nothing is sent back to the assistant.
 */
export function TaskItem({ checked, children }: { checked?: boolean; children?: ReactNode }): ReactNode {
  const { s, theme } = useMdxKit();
  const [done, setDone] = useState(checked ?? false);
  return (
    <View style={s.listItem}>
      <Pressable
        onPress={() => setDone((v) => !v)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
      >
        <Text style={[s.listMarker, { color: done ? theme.live : theme.dim }]}>{done ? '☑' : '☐'}</Text>
      </Pressable>
      <View style={s.listBody}>{children}</View>
    </View>
  );
}

/** A table body shared by GFM tables and <DataTable>. */
function TableFrame({ children }: { children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return (
    <View style={s.tableWrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ minWidth: '100%' }}>
        <View>{children}</View>
      </ScrollView>
    </View>
  );
}

export function MdxTable({ children }: { children?: ReactNode }): ReactNode {
  return <TableFrame>{children}</TableFrame>;
}

export function MdxTableRow({ head, children }: { head?: boolean; children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return <View style={head ? s.tableHeadRow : s.tableRow}>{children}</View>;
}

export function MdxTableCell({ head, children }: { head?: boolean; children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return (
    <View style={s.tableCell}>
      <Text style={head ? s.tableHeadText : s.tableText}>{children}</Text>
    </View>
  );
}

/** Shown where a component's payload could not be read: the raw block, labelled. */
function Unreadable({ what, raw }: { what: string; raw?: string }): ReactNode {
  const { s } = useMdxKit();
  return (
    <View>
      <Text style={s.error}>Could not read {what}.</Text>
      {raw ? <CodeBlock value={raw} /> : null}
    </View>
  );
}

// ---- Callout ---------------------------------------------------------------

export function Callout({ type, children }: { type?: string; children?: ReactNode }): ReactNode {
  const { s, tint } = useMdxKit();
  const kind = ['info', 'warn', 'success', 'danger'].includes(type ?? '') ? (type as string) : 'info';
  return <View style={[s.callout, { borderLeftColor: tint(kind) }]}>{children}</View>;
}

// ---- Steps -----------------------------------------------------------------

/**
 * Marker: <Steps> collects these to number them, because RN has no <ol> and the
 * index has to come from somewhere. Rendered standalone it still shows, bulleted.
 */
export function Step({ children }: { children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return (
    <View style={s.step}>
      <View style={s.stepNumber}>
        <Text style={s.stepNumberText}>•</Text>
      </View>
      <View style={s.stepBody}>{children}</View>
    </View>
  );
}

export function Steps({ children }: { children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  const steps = collectByType<{ children?: ReactNode }>(children, Step);
  if (steps.length === 0) return <View style={s.steps}>{children}</View>;
  return (
    <View style={s.steps}>
      {steps.map((step, i) => (
        <View style={s.step} key={i}>
          <View style={s.stepNumber}>
            <Text style={s.stepNumberText}>{i + 1}</Text>
          </View>
          <View style={s.stepBody}>{step.props.children}</View>
        </View>
      ))}
    </View>
  );
}

// ---- Collapsible -----------------------------------------------------------

export function Collapsible({ title, children }: { title?: string; children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  const [open, setOpen] = useState(false);
  return (
    <View style={s.collapsible}>
      <Pressable style={s.collapsibleHeader} onPress={() => setOpen((v) => !v)} accessibilityRole="button">
        <Text style={s.collapsibleCaret}>{open ? '▾' : '▸'}</Text>
        <Text style={s.collapsibleTitle}>{title ?? 'Details'}</Text>
      </Pressable>
      {open ? <View style={s.collapsibleBody}>{children}</View> : null}
    </View>
  );
}

// ---- Tabs ------------------------------------------------------------------

/** Marker: <Tabs> reads label + content off these. Standalone it shows its body. */
export function TabPanel({ children }: { label?: string; children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  return <View style={s.tabBody}>{children}</View>;
}

export function Tabs({ children }: { children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  const [active, setActive] = useState(0);
  const panels = collectByType<{ label?: string; children?: ReactNode }>(children, TabPanel);
  if (panels.length === 0) return <View style={s.tabs}>{children}</View>;
  const current = Math.min(active, panels.length - 1);
  return (
    <View style={s.tabs}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={s.tabBar}>
          {panels.map((p, i) => (
            <Pressable
              key={i}
              style={[s.tab, i === current && s.tabActive]}
              onPress={() => setActive(i)}
              accessibilityRole="tab"
              accessibilityState={{ selected: i === current }}
            >
              <Text style={[s.tabLabel, i === current && s.tabLabelActive]}>{p.props.label ?? `Tab ${i + 1}`}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      <View style={s.tabBody}>{panels[current].props.children}</View>
    </View>
  );
}

// ---- DataTable -------------------------------------------------------------

export function DataTable({ data, caption }: { data?: string; caption?: string }): ReactNode {
  const { s } = useMdxKit();
  const table = useMemo(() => parseTable(data), [data]);
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);

  if (!table || table.columns.length === 0) return <Unreadable what="table data" raw={data} />;

  const ordered: Row[] = sort ? sortRows(table.rows, sort.col, sort.dir) : table.rows;
  const shown = ordered.slice(0, MAX_TABLE_ROWS);
  const hidden = ordered.length - shown.length;

  const toggleSort = (col: string): void =>
    setSort((prev) => (prev && prev.col === col ? { col, dir: prev.dir === 1 ? -1 : 1 } : { col, dir: 1 }));

  return (
    <View>
      {caption ? <Text style={s.tableCaption}>{caption}</Text> : null}
      <TableFrame>
        <View style={s.tableHeadRow}>
          {table.columns.map((c) => (
            <Pressable key={c} style={s.tableCell} onPress={() => toggleSort(c)} accessibilityRole="button">
              <Text style={s.tableHeadText}>
                {c} <Text style={s.tableCaret}>{sort && sort.col === c ? (sort.dir === 1 ? '▲' : '▼') : '↕'}</Text>
              </Text>
            </Pressable>
          ))}
        </View>
        {shown.map((r, i) => (
          <View style={s.tableRow} key={i}>
            {table.columns.map((c) => (
              <View style={s.tableCell} key={c}>
                <Text style={s.tableText}>{cellText(r[c])}</Text>
              </View>
            ))}
          </View>
        ))}
      </TableFrame>
      {hidden > 0 ? (
        <Text style={s.note}>
          {hidden} more {hidden === 1 ? 'row' : 'rows'} — tap a column to sort.
        </Text>
      ) : null}
    </View>
  );
}

// ---- Chart -----------------------------------------------------------------

export function Chart({ title, data }: { type?: string; title?: string; data?: string }): ReactNode {
  const { s } = useMdxKit();
  const series = useMemo(() => parseSeries(data), [data]);
  if (!series) return <Unreadable what="chart data" raw={data} />;
  const bars = barGeometry(series);
  return (
    <View style={s.chart}>
      {title ? <Text style={s.chartTitle}>{title}</Text> : null}
      {series.map((d, i) => (
        <View style={s.chartRow} key={i}>
          <Text style={s.chartLabel} numberOfLines={1}>
            {d.label}
          </Text>
          <View style={s.chartTrack}>
            <View
              style={[
                s.chartBar,
                // A one-percent floor so a zero-valued point is still a visible
                // mark on its row rather than a gap the reader has to interpret.
                { marginLeft: `${bars[i].offset * 100}%`, width: `${Math.max(bars[i].length * 100, 1)}%` }
              ]}
            />
          </View>
          <Text style={s.chartValue}>{formatValue(d.value)}</Text>
        </View>
      ))}
    </View>
  );
}

// ---- Quiz ------------------------------------------------------------------

export function QuizChoice({ children }: { children?: ReactNode }): ReactNode {
  return <>{children}</>;
}

export function QuizQuestion(props: { prompt?: string; answer?: string; children?: ReactNode }): ReactNode {
  return <>{props.children}</>;
}

export function Quiz({ topic, children }: { topic?: string; children?: ReactNode }): ReactNode {
  const { s } = useMdxKit();
  const actions = useMdxActions();
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState(false);
  const [sent, setSent] = useState(false);

  const questions = collectByType<{ prompt?: string; answer?: string; children?: ReactNode }>(children, QuizQuestion);
  if (questions.length === 0) return <View style={s.panel}>{children}</View>;

  const choicesOf = (q: { props: { children?: ReactNode } }): Array<ReactElement<{ children?: ReactNode }>> =>
    collectByType<{ children?: ReactNode }>(q.props.children, QuizChoice);
  const answerOf = (q: { props: { answer?: string } }): string => (q.props.answer ?? '').trim().toLowerCase();
  const isCorrect = (qi: number, q: (typeof questions)[number]): boolean => {
    const sel = selected[qi];
    if (sel === undefined) return false;
    return nodeText(choicesOf(q)[sel]).trim().toLowerCase() === answerOf(q);
  };

  const allAnswered = questions.every((_, qi) => selected[qi] !== undefined);
  const score = questions.reduce((acc, q, qi) => acc + (isCorrect(qi, q) ? 1 : 0), 0);

  // Only ever fires from the user's tap — never on render — so the assistant
  // cannot trigger its own follow-up turns.
  const explain = (): void => {
    if (!actions || actions.running || sent) return;
    const wrong = questions
      .map((q, qi) => ({ q, qi }))
      .filter(({ q, qi }) => !isCorrect(qi, q))
      .map(({ q, qi }) => {
        const sel = selected[qi];
        const chosen = sel === undefined ? '(no answer)' : nodeText(choicesOf(q)[sel]).trim();
        return `- "${q.props.prompt ?? `Question ${qi + 1}`}" — I answered "${chosen}" (correct: "${q.props.answer ?? ''}").`;
      });
    const head = `I took the ${topic ? `${topic} ` : ''}quiz and scored ${score}/${questions.length}.`;
    const body = wrong.length
      ? `\nI got these wrong:\n${wrong.join('\n')}\nPlease explain the ones I missed.`
      : `\nI got them all right — anything else worth knowing about ${topic ?? 'this topic'}?`;
    actions.submit(`${head}${body}`);
    setSent(true);
  };

  return (
    <View style={s.panel}>
      {topic ? <Text style={s.panelTitle}>{topic}</Text> : null}
      {questions.map((q, qi) => (
        <View key={qi}>
          <Text style={s.prompt}>{q.props.prompt ?? `Question ${qi + 1}`}</Text>
          {choicesOf(q).map((c, ci) => {
            const picked = selected[qi] === ci;
            const correct = checked && nodeText(c).trim().toLowerCase() === answerOf(q);
            return (
              <Pressable
                key={ci}
                disabled={checked}
                style={[s.choice, picked && s.choicePicked, correct && s.choiceCorrect, checked && picked && !correct && s.choiceWrong]}
                onPress={() => setSelected((prev) => ({ ...prev, [qi]: ci }))}
                accessibilityRole="radio"
                accessibilityState={{ selected: picked }}
              >
                {c}
              </Pressable>
            );
          })}
        </View>
      ))}
      {!checked ? (
        <Pressable
          style={[s.button, !allAnswered && s.buttonDisabled]}
          disabled={!allAnswered}
          onPress={() => setChecked(true)}
          accessibilityRole="button"
        >
          <Text style={s.buttonText}>Check answers</Text>
        </Pressable>
      ) : (
        <View style={s.row}>
          <Text style={s.buttonText}>
            Score: {score}/{questions.length}
          </Text>
          {actions ? (
            <Pressable
              style={[s.button, (actions.running || sent) && s.buttonDisabled]}
              disabled={actions.running || sent}
              onPress={explain}
              accessibilityRole="button"
            >
              <Text style={s.buttonText}>{sent ? 'Sent to Stem' : 'Explain what I missed'}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

// ---- Form ------------------------------------------------------------------

/** Marker: <Form> reads these and renders the real inputs itself. */
export function FormField(_props: {
  name?: string;
  label?: string;
  placeholder?: string;
  type?: string;
}): ReactNode {
  return null;
}

export function Form({
  prompt,
  submitLabel,
  children
}: {
  prompt?: string;
  submitLabel?: string;
  children?: ReactNode;
}): ReactNode {
  const { s, theme } = useMdxKit();
  const actions = useMdxActions();
  const [values, setValues] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  const fields = collectByType<{ name?: string; label?: string; placeholder?: string; type?: string }>(
    children,
    FormField
  );
  if (fields.length === 0) return <View style={s.panel}>{children}</View>;

  const keyOf = (f: { props: { name?: string; label?: string } }, i: number): string =>
    f.props.name ?? f.props.label ?? `field-${i}`;

  const submit = (): void => {
    if (!actions || actions.running || sent) return;
    const lines = fields.map((f, i) => {
      const key = keyOf(f, i);
      return `- ${f.props.label ?? f.props.name ?? key}: ${values[key] ?? ''}`;
    });
    actions.submit(`${prompt ? `${prompt}\n` : ''}${lines.join('\n')}`);
    setSent(true);
  };

  return (
    <View style={s.panel}>
      {prompt ? <Text style={s.prompt}>{prompt}</Text> : null}
      {fields.map((f, i) => {
        const key = keyOf(f, i);
        const type = f.props.type ?? 'text';
        return (
          <View key={key}>
            <Text style={s.fieldLabel}>{f.props.label ?? f.props.name ?? key}</Text>
            <TextInput
              style={[s.input, type === 'textarea' && { minHeight: 72 }]}
              value={values[key] ?? ''}
              placeholder={f.props.placeholder}
              placeholderTextColor={theme.dim}
              editable={!sent}
              multiline={type === 'textarea'}
              keyboardType={type === 'number' ? 'numeric' : 'default'}
              onChangeText={(v) => setValues((prev) => ({ ...prev, [key]: v }))}
            />
          </View>
        );
      })}
      {actions ? (
        <Pressable
          style={[s.button, (actions.running || sent) && s.buttonDisabled]}
          disabled={actions.running || sent}
          onPress={submit}
          accessibilityRole="button"
        >
          <Text style={s.buttonText}>{sent ? 'Sent' : (submitLabel ?? 'Submit')}</Text>
        </Pressable>
      ) : (
        // No provider yet on this screen: say where the answer goes rather than
        // showing a button that would do nothing.
        <Text style={s.note}>Answer in the message box below.</Text>
      )}
    </View>
  );
}

// ---- The allow-list --------------------------------------------------------

type DataChild = { lang?: string; value: string };
type ComponentEntry = (props: Record<string, string>, children: ReactNode, data?: DataChild) => ReactNode;

/** Allow-list of model-usable components, keyed by tag name. Mirrors the desktop's. */
export const componentMap: Record<string, ComponentEntry> = {
  Callout: (props, children) => <Callout type={props.type}>{children}</Callout>,
  Steps: (_props, children) => <Steps>{children}</Steps>,
  Step: (_props, children) => <Step>{children}</Step>,
  Collapsible: (props, children) => <Collapsible title={props.title}>{children}</Collapsible>,
  Tabs: (_props, children) => <Tabs>{children}</Tabs>,
  Tab: (props, children) => <TabPanel label={props.label}>{children}</TabPanel>,
  DataTable: (props, _children, data) => <DataTable data={data?.value} caption={props.caption} />,
  Chart: (props, _children, data) => <Chart type={props.type} title={props.title} data={data?.value} />,
  Quiz: (props, children) => <Quiz topic={props.topic}>{children}</Quiz>,
  Question: (props, children) => (
    <QuizQuestion prompt={props.prompt} answer={props.answer}>
      {children}
    </QuizQuestion>
  ),
  Choice: (_props, children) => <QuizChoice>{children}</QuizChoice>,
  Form: (props, children) => (
    <Form prompt={props.prompt} submitLabel={props.submitLabel}>
      {children}
    </Form>
  ),
  Field: (props) => (
    <FormField name={props.name} label={props.label} placeholder={props.placeholder} type={props.type} />
  )
};
