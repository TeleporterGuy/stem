// The bridge interactive MDX components use to answer the assistant.
//
// Same contract as the desktop's src/renderer/mdx/ActionContext.tsx, and the
// same trust model: `submit` starts a turn by the ordinary composer path, so
// whatever a <Quiz> or <Form> sends appears in the transcript as a user message
// and can do nothing the user could not have typed. Components MUST only call it
// from a real gesture, never on mount, so the assistant can never trigger its own
// follow-up turn.
//
// Nothing on the phone provides it yet. That is why the type exists here rather
// than being invented later: the components already treat "no provider" as a
// first-class state (they render, they just do not offer to send), so wiring the
// thread screen's `send` in is a provider and no component change. Until then a
// quiz still scores you and a form still shows you what it wants — which is the
// point of the fallback rule, applied to ourselves.

import { createContext, useContext } from 'react';

export interface MdxActions {
  submit: (text: string) => void;
  /** A turn is already running; overlapping sends are refused by the backend. */
  running: boolean;
}

export const MdxActionContext = createContext<MdxActions | null>(null);

export function useMdxActions(): MdxActions | null {
  return useContext(MdxActionContext);
}
