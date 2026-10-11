import { createContext, useContext } from 'react';

// Where a <Form>'s answers are sent from. A view that hosts forms (a chat, a
// mail thread) owns one Send button in its answer bar, next to the input the
// user already types in, instead of a submit button inside each form: the
// input stays free for asking about a question, and asking never costs the
// picks already made (they live in the draft store below, not in the form).

export interface HostedForm {
  key: string;
  answered: number;
  total: number;
  /** Send the answers: one message, through the view's normal send path. */
  send(): void;
  /** Scroll the form into view and flash it. */
  reveal(): void;
  /** The form's element, to order forms by their place in the page. */
  el(): HTMLElement | null;
}

export interface FormHost {
  /** Where the answer bar sits relative to the forms: below in a chat, above in mail. */
  place: 'below' | 'above';
  register(form: HostedForm): () => void;
  /** A registered form's counts changed. */
  changed(): void;
  subscribe(listener: () => void): () => void;
  forms(): HostedForm[];
  /** The user wants to ask about one question: put it in the input. */
  ask(label: string): void;
}

export function createFormHost(place: FormHost['place'], ask: (label: string) => void): FormHost {
  const registered = new Map<string, HostedForm>();
  const listeners = new Set<() => void>();
  let snapshot: HostedForm[] = [];
  const notify = () => {
    snapshot = [...registered.values()];
    for (const l of listeners) l();
  };
  return {
    place,
    register(form) {
      registered.set(form.key, form);
      notify();
      return () => {
        if (registered.get(form.key) === form) registered.delete(form.key);
        notify();
      };
    },
    changed: notify,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forms: () => snapshot,
    ask
  };
}

export const FormHostContext = createContext<FormHost | null>(null);

export function useFormHost(): FormHost | null {
  return useContext(FormHostContext);
}

/** The message or mail a component renders in: forms key their drafts by it. */
export const MdxSourceContext = createContext<string>('');

export function useMdxSource(): string {
  return useContext(MdxSourceContext);
}

// ---- drafts: picks survive re-renders, chat switches and restarts -------------

export type FieldValue = string | string[];

export interface FormDraft {
  values: Record<string, FieldValue>;
  /** Text typed under "Other…", per field. */
  others: Record<string, string>;
  sent: boolean;
}

const STORAGE_KEY = 'stem.formDrafts';
const MAX_DRAFTS = 200;
const drafts = new Map<string, FormDraft>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, FormDraft>) : {};
    for (const [k, v] of Object.entries(parsed)) drafts.set(k, v);
  } catch {
    // quiet: no storage (or a corrupt entry) only means drafts start empty.
  }
}

function persist(): void {
  try {
    const entries = [...drafts.entries()].slice(-MAX_DRAFTS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // quiet: drafts still live for this session.
  }
}

export function readFormDraft(key: string): FormDraft {
  load();
  return drafts.get(key) ?? { values: {}, others: {}, sent: false };
}

export function writeFormDraft(key: string, draft: FormDraft): void {
  load();
  drafts.delete(key); // re-insert so the newest drafts are the ones kept
  drafts.set(key, draft);
  persist();
}
