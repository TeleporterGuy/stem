// One StyleSheet for the whole MDX renderer, derived from the app theme.
//
// It is a context rather than a prop because of who the readers are: the walker
// builds the element tree in one pass, but the components it instantiates run
// later, as components, and threading a style object through every <Tabs> into
// every <Tab> would be prop-drilling through code that exists to be read. The
// walker publishes the kit once at the root; everything below asks for it.
//
// Cached per theme object, like AgentMarkdown's map was — `useTheme` returns one
// of two module constants, so a WeakMap here means the sheet is built twice in
// the life of the process, not once per bubble per token.

import { Platform, StyleSheet } from 'react-native';
import { createContext, useContext } from 'react';
import type { Theme } from '../ui/theme';

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

function build(theme: Theme) {
  return StyleSheet.create({
    // --- block flow ---------------------------------------------------------
    root: { width: '100%' },
    group: { width: '100%' },
    paragraph: { color: theme.text, fontSize: 16, lineHeight: 23, marginBottom: 10 },
    heading1: { color: theme.text, fontSize: 21, fontWeight: '700', marginTop: 10, marginBottom: 6 },
    heading2: { color: theme.text, fontSize: 19, fontWeight: '700', marginTop: 10, marginBottom: 5 },
    heading3: { color: theme.text, fontSize: 17, fontWeight: '700', marginTop: 8, marginBottom: 4 },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: theme.line,
      paddingLeft: 10,
      marginBottom: 10
    },
    rule: { height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginVertical: 12 },
    list: { marginBottom: 10 },
    listItem: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 2 },
    listMarker: { color: theme.dim, fontSize: 16, lineHeight: 23, minWidth: 22 },
    listBody: { flex: 1 },
    image: { width: '100%', height: 180, marginBottom: 10, borderRadius: 6 },

    // --- inline -------------------------------------------------------------
    strong: { fontWeight: '700' },
    emphasis: { fontStyle: 'italic' },
    strike: { textDecorationLine: 'line-through' },
    link: { color: theme.accent, textDecorationLine: 'underline' },
    inlineCode: { fontFamily: mono, fontSize: 14, color: theme.text, backgroundColor: theme.card },

    // --- code ---------------------------------------------------------------
    // Horizontal scroll rather than wrap: a wrapped command line is a command
    // line you cannot copy correctly.
    codeBlock: {
      backgroundColor: theme.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.line,
      borderRadius: 8,
      marginBottom: 10
    },
    codeScroll: { padding: 10 },
    codeText: { fontFamily: mono, fontSize: 13, lineHeight: 19, color: theme.text },
    codeLang: {
      color: theme.dim,
      fontSize: 11,
      paddingHorizontal: 10,
      paddingTop: 6,
      textTransform: 'uppercase'
    },

    // --- tables (GFM and <DataTable>) ---------------------------------------
    tableWrap: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.line,
      borderRadius: 8,
      marginBottom: 10,
      overflow: 'hidden'
    },
    tableRow: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
    tableHeadRow: { flexDirection: 'row', backgroundColor: theme.card },
    tableCell: { paddingHorizontal: 10, paddingVertical: 7, minWidth: 96, flexGrow: 1, flexBasis: 0 },
    tableText: { color: theme.text, fontSize: 14, lineHeight: 19 },
    tableHeadText: { color: theme.text, fontSize: 13, fontWeight: '700' },
    tableCaption: { color: theme.dim, fontSize: 12, marginBottom: 4 },
    tableCaret: { color: theme.dim, fontSize: 11 },

    // --- Callout ------------------------------------------------------------
    callout: {
      borderLeftWidth: 3,
      borderRadius: 6,
      backgroundColor: theme.card,
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 2,
      marginBottom: 10
    },

    // --- Steps --------------------------------------------------------------
    steps: { marginBottom: 10 },
    step: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
    stepNumber: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: theme.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.line,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 8,
      marginTop: 1
    },
    stepNumberText: { color: theme.dim, fontSize: 12, fontWeight: '700' },
    stepBody: { flex: 1 },

    // --- Collapsible --------------------------------------------------------
    collapsible: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.line,
      borderRadius: 8,
      marginBottom: 10,
      overflow: 'hidden'
    },
    collapsibleHeader: { flexDirection: 'row', alignItems: 'center', padding: 10, backgroundColor: theme.card },
    collapsibleCaret: { color: theme.dim, fontSize: 12, marginRight: 8 },
    collapsibleTitle: { color: theme.text, fontSize: 15, fontWeight: '600', flex: 1 },
    collapsibleBody: { paddingHorizontal: 10, paddingTop: 10 },

    // --- Tabs ---------------------------------------------------------------
    tabs: { marginBottom: 10 },
    tabBar: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
    tab: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: 'transparent' },
    tabActive: { borderBottomColor: theme.accent },
    tabLabel: { color: theme.dim, fontSize: 14 },
    tabLabelActive: { color: theme.text, fontWeight: '600' },
    tabBody: { paddingTop: 10 },

    // --- Chart --------------------------------------------------------------
    chart: { marginBottom: 10 },
    chartTitle: { color: theme.text, fontSize: 14, fontWeight: '600', marginBottom: 6 },
    chartRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
    chartLabel: { color: theme.dim, fontSize: 12, width: 76 },
    chartTrack: { flex: 1, height: 14, backgroundColor: theme.card, borderRadius: 3, overflow: 'hidden' },
    chartBar: { height: 14, backgroundColor: theme.accent, borderRadius: 3 },
    chartValue: { color: theme.text, fontSize: 12, width: 52, textAlign: 'right' },

    // --- Quiz / Form --------------------------------------------------------
    panel: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.line,
      borderRadius: 8,
      padding: 12,
      marginBottom: 10
    },
    panelTitle: { color: theme.dim, fontSize: 12, textTransform: 'uppercase', marginBottom: 8 },
    prompt: { color: theme.text, fontSize: 15, fontWeight: '600', marginBottom: 6 },
    choice: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.line,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      marginBottom: 6
    },
    choicePicked: { borderColor: theme.accent, backgroundColor: theme.card },
    choiceCorrect: { borderColor: theme.live },
    choiceWrong: { borderColor: theme.bad },
    fieldLabel: { color: theme.dim, fontSize: 12, marginBottom: 4 },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.line,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: theme.text,
      backgroundColor: theme.card,
      marginBottom: 8,
      fontSize: 15
    },
    button: {
      alignSelf: 'flex-start',
      borderRadius: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: theme.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.line
    },
    buttonText: { color: theme.text, fontSize: 14, fontWeight: '600' },
    buttonDisabled: { opacity: 0.45 },
    note: { color: theme.dim, fontSize: 12, marginTop: 4 },
    error: { color: theme.dim, fontSize: 13, fontStyle: 'italic', marginBottom: 10 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10 }
  });
}

export interface MdxKit {
  theme: Theme;
  s: ReturnType<typeof build>;
  /** Accent for each callout kind, and for the chart bars. */
  tint(kind: string): string;
}

const cache = new WeakMap<Theme, MdxKit>();

export function mdxKit(theme: Theme): MdxKit {
  const cached = cache.get(theme);
  if (cached) return cached;
  const kit: MdxKit = {
    theme,
    s: build(theme),
    tint: (kind) =>
      kind === 'warn' ? theme.warn : kind === 'success' ? theme.live : kind === 'danger' ? theme.bad : theme.accent
  };
  cache.set(theme, kit);
  return kit;
}

// Only null before a provider exists, which the walker always mounts; the hook
// throws rather than rendering an unstyled tree, because an unstyled tree on a
// phone is invisible text on an invisible background.
const KitContext = createContext<MdxKit | null>(null);

export const MdxKitProvider = KitContext.Provider;

export function useMdxKit(): MdxKit {
  const kit = useContext(KitContext);
  if (!kit) throw new Error('MDX component rendered outside MdxKitProvider');
  return kit;
}
