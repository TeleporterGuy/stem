import type { ChatFeatureSettings, PersonaComputerPin, PersonaHarnessPin } from '../../shared/types';

// Who may use coding_agent and `computer` this turn, and on what. A persona's
// pin is the whole story for a persona turn (chat, mail or schedule) — a persona
// without one gets neither tool whatever Settings says. A chat run as NO
// persona follows Settings → Features (chatFeatures, 2026-09-27): off, a fixed
// agent/computer the server fills in, or the model choosing per call. The
// refusals say which of those applies, because Stem is the one who has to
// explain to the user why the tool is not there.

export type CodingGrant =
  | { kind: 'pin'; pin: PersonaHarnessPin }
  /** `target: null` = the model names agent and device per call. */
  | { kind: 'chat'; target: { agent: string; device?: string } | null };

export type ComputerGrant =
  | { kind: 'pin'; device: string }
  /** `device: null` = the model names the Mac per call. */
  | { kind: 'chat'; device: string | null };

export type Granted<G> = { ok: true; grant: G } | { ok: false; refusal: string };

export interface GrantTurn {
  persona?: { name?: string; harness?: PersonaHarnessPin; computer?: PersonaComputerPin };
  /** A scheduled run or a mail delivery — never a plain chat, persona or not. */
  unattended: boolean;
}

const personaLabel = (name: string | undefined): string => (name?.trim() ? `the persona “${name.trim()}”` : 'a persona');

export function resolveCodingGrant(turn: GrantTurn, chat: ChatFeatureSettings['coding']): Granted<CodingGrant> {
  const pin = turn.persona?.harness;
  if (pin?.agent?.trim()) return { ok: true, grant: { kind: 'pin', pin } };
  if (turn.persona) {
    return {
      ok: false,
      refusal:
        `This conversation runs as ${personaLabel(turn.persona.name)}, which has no coding setup, so it has no ` +
        "coding agent. A persona gets one from its coding setup (Manage → Personas); only chats that run as no " +
        'persona follow Settings → Features → Coding agents. Do not retry; tell the user this, and which code ' +
        'persona should take the task or that this one needs a coding setup.'
    };
  }
  if (turn.unattended) {
    return {
      ok: false,
      refusal:
        'Coding agents in scheduled runs need a code persona — a persona with a coding setup (Manage → ' +
        'Personas). This run has no persona, so do not retry; tell the user to run the task as a code persona.'
    };
  }
  if (!chat.allow) {
    return {
      ok: false,
      refusal:
        'Coding agents are off for chats that run as no persona. Do not retry; tell the user they can turn ' +
        'them on in Settings → Features → Coding agents ("Allow in chats"), or hand the task to a persona ' +
        'with a coding setup.'
    };
  }
  return { ok: true, grant: { kind: 'chat', target: chat.target } };
}

export function resolveComputerGrant(turn: GrantTurn, chat: ChatFeatureSettings['computer']): Granted<ComputerGrant> {
  const device = turn.persona?.computer?.device?.trim();
  if (device) return { ok: true, grant: { kind: 'pin', device } };
  // Every refusal ends the same way: scripting the GUI over run_command is not
  // a way around it (ExecService refuses it on a Mac someone owns).
  const noWorkaround =
    'Do not work around it by scripting the GUI over run_command (osascript at System Events, cliclick) — ' +
    'that is refused too.';
  if (turn.persona) {
    return {
      ok: false,
      refusal:
        `This conversation runs as ${personaLabel(turn.persona.name)}, which controls no computer, so it has ` +
        'no computer control. A persona gets it from its computer pin (Manage → Personas → "Computer this ' +
        'persona controls"); only chats that run as no persona follow Settings → Features → Computer control. ' +
        `Do not retry. ${noWorkaround} Hand the task to the pinned persona (add_persona + send_mail in a mail ` +
        'thread), or tell the user which persona should take it, or that one needs setting up.'
    };
  }
  if (turn.unattended) {
    return {
      ok: false,
      refusal:
        'Computer control in scheduled runs needs a persona pinned to a computer (Manage → Personas). This run ' +
        `has no persona, so do not retry. ${noWorkaround} Tell the user to run the task as such a persona.`
    };
  }
  if (!chat.allow) {
    return {
      ok: false,
      refusal:
        'Computer control is off for chats that run as no persona. Do not retry. ' +
        `${noWorkaround} Tell the user they can turn it on in Settings → Features → Computer control ` +
        '("Allow in chats"), or hand the task to a persona pinned to a computer.'
    };
  }
  return { ok: true, grant: { kind: 'chat', device: chat.target?.device ?? null } };
}

