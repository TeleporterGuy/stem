// The settings the phone offers, written down as data rather than as screens.
//
// One entry per setting: what it is called, what kind of control it takes, how
// to read it out of the server's settings document and how to write it back.
// The screen (app/(tabs)/settings) is a renderer of this list and knows nothing
// about any individual setting — adding one is adding an entry here.
//
// `mobile` is the field that says whether a setting belongs on the phone at
// all. Absent means yes — these are server settings, and a phone is as
// legitimate a place to change the server as the desk is — so a setting has to
// say `mobile: false` to stay off, and the ones that do are the ones whose
// subject is a desk: a keyboard's Escape key, the Quick Chat overlay. They keep
// full entries anyway, because "exists but not here" is information the next
// reader needs; filtering happens in {@link mobileGroups}.

import type {
  ChatSubjectMode,
  EscapeAction,
  ExecApprovalMode,
  SkillsMode,
  TaskNotifyMode
} from '@shared/types';
import type { ChannelResult } from '../transport/channels';
import type { Connection } from '../transport/connection';

/** What `settings:get` answers with — the server's whole settings document. */
export type Settings = ChannelResult<'settings:get'>;

interface BaseSetting {
  /** Stable id, used as the list key. */
  key: string;
  label: string;
  /** One line under the label saying what the setting does. */
  hint?: string;
  /**
   * Whether this setting is offered on the phone. Default true — omit it unless
   * the setting is about a machine the phone is not (a keyboard, an overlay).
   */
  mobile?: boolean;
}

interface Shown {
  /** Hide the row while this says false — a follow-up to a switch that is off. */
  visible?: (s: Settings) => boolean;
}

/** An on/off setting, rendered as a switch. */
export interface ToggleSetting extends BaseSetting, Shown {
  kind: 'toggle';
  read: (s: Settings) => boolean;
  save: (c: Connection, value: boolean) => Promise<Settings>;
}

/** A pick-one setting, rendered as a row that opens its options. */
export interface ChoiceSetting extends BaseSetting, Shown {
  kind: 'choice';
  options: { value: string; label: string }[];
  read: (s: Settings) => string;
  save: (c: Connection, value: string) => Promise<Settings>;
}

/**
 * A model pick. Its options are not written here — they are whatever
 * `backend:listModels` answers, which the screen fetches — so all an entry
 * carries is the role: where its pick lives and what null means there.
 */
export interface ModelSetting extends BaseSetting {
  kind: 'model';
  /** What no pick falls through to ("Stem default", "Same as chat"). */
  nullLabel: string;
  read: (s: Settings) => string | null;
  save: (c: Connection, value: string | null) => Promise<Settings>;
}

/**
 * A pick-one setting whose options live on the server (paired computers, agent
 * names), fetched by the row. A stored value missing from the answer still
 * shows, labelled as-is, rather than reading as nothing.
 */
export interface DynamicChoiceSetting extends BaseSetting, Shown {
  kind: 'dynamicChoice';
  load: (c: Connection) => Promise<{ value: string; label: string }[]>;
  read: (s: Settings) => string;
  save: (c: Connection, value: string, s: Settings) => Promise<Settings>;
}

export type SettingDef = ToggleSetting | ChoiceSetting | ModelSetting | DynamicChoiceSetting;

// Settings → Features' "in chats" rows. The coding target is two picks on one
// value — where, and which agent — and '' is "let the model choose".
const CHOOSE = '';
type CodingTarget = Settings['chatFeatures']['coding']['target'];
// An older server answers without `chatFeatures`: read as off, not a crash.
const OFF = { allow: false, target: null };
const chatCoding = (s: Settings): Settings['chatFeatures']['coding'] => s.chatFeatures?.coding ?? OFF;
const chatComputer = (s: Settings): Settings['chatFeatures']['computer'] => s.chatFeatures?.computer ?? OFF;
const defaultAgent = (s: Settings): string => chatCoding(s).target?.agent ?? 'claude';
function codingWhere(target: CodingTarget): string {
  return target ? (target.device ?? 'server') : CHOOSE;
}

export interface SettingsGroup {
  title: string;
  settings: SettingDef[];
}

// Ordered the way the desktop orders its tabs: App (the conversation and how
// loudly Stem may interrupt), then Features (what it may DO), then Models, then
// the desk-only leftovers.
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: 'App',
    settings: [
      {
        kind: 'toggle',
        key: 'web-search',
        label: 'Web search',
        hint: 'Live results with citations',
        read: (s) => s.webSearch.main,
        save: (c, main) => c.rpc('settings:updateWebSearch', { main })
      },
      {
        kind: 'choice',
        key: 'subjects',
        label: 'Subjects',
        hint: 'Stem writes each chat a short subject, like an email thread',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'inbox', label: 'Inbox only' },
          { value: 'everywhere', label: 'Everywhere' }
        ],
        read: (s) => s.chats.subjects,
        save: (c, v) => c.rpc('settings:updateChats', { subjects: v as ChatSubjectMode })
      },
      {
        kind: 'choice',
        key: 'preview-lines',
        label: 'Preview lines in Chats',
        hint: 'How much of the newest message each row shows',
        options: [
          { value: '0', label: 'None' },
          { value: '1', label: '1 line' },
          { value: '2', label: '2 lines' }
        ],
        read: (s) => String(s.chats.previewLines),
        save: (c, v) => c.rpc('settings:updateChats', { previewLines: Number(v) as 0 | 1 | 2 })
      },
      {
        kind: 'choice',
        key: 'tasks-notify',
        label: 'Scheduled tasks',
        hint: 'Task results stay in Chats or Mail — choose how you are notified',
        options: [
          { value: 'alert', label: 'Pop-up' },
          { value: 'nudge', label: 'Nudge' },
          { value: 'inbox', label: 'Inbox only' }
        ],
        read: (s) => s.tasks.notify,
        save: (c, v) => c.rpc('settings:updateTasks', { notify: v as TaskNotifyMode })
      }
    ]
  },
  {
    title: 'Features',
    settings: [
      {
        kind: 'toggle',
        key: 'exec-enabled',
        label: 'Run commands',
        hint: 'Let Stem run shell commands while it works',
        read: (s) => s.exec.enabled,
        save: (c, enabled) => c.rpc('settings:updateExec', { enabled })
      },
      {
        kind: 'choice',
        key: 'exec-approval',
        label: 'Command approvals',
        hint: 'Assisted clears commands that serve your request; only flagged ones pause',
        options: [
          { value: 'manual', label: 'Ask every time' },
          { value: 'assisted', label: 'Assisted' },
          { value: 'yolo', label: 'Never ask' }
        ],
        read: (s) => s.exec.approvalMode,
        save: (c, v) => c.rpc('settings:updateExec', { approvalMode: v as ExecApprovalMode })
      },
      {
        kind: 'choice',
        key: 'skills-mode',
        label: 'Skill writing',
        hint: 'Whether Stem saves new skills itself or shows you first',
        options: [
          { value: 'ask', label: 'Ask first' },
          { value: 'auto', label: 'Automatic' },
          { value: 'off', label: 'Off' }
        ],
        read: (s) => s.skills.mode,
        save: (c, v) => c.rpc('settings:updateSkills', { mode: v as SkillsMode })
      },
      // Coding agents / computer control in chats that run as no persona.
      // Personas follow their own pins whatever these say.
      {
        kind: 'toggle',
        key: 'chat-coding',
        label: 'Coding agents in chats',
        hint: 'Chats with no persona can hand work to a coding agent when you ask',
        read: (s) => chatCoding(s).allow,
        save: (c, allow) =>
          c.rpc('settings:get').then((s) =>
            c.rpc('settings:updateChatFeatures', { coding: { ...chatCoding(s), allow } })
          )
      },
      {
        kind: 'dynamicChoice',
        key: 'chat-coding-where',
        label: 'Run on',
        hint: 'Where chats’ coding agents run',
        visible: (s) => chatCoding(s).allow,
        load: (c) =>
          c.rpc('devices:list').then((snap) => [
            { value: CHOOSE, label: 'Let the model choose' },
            { value: 'server', label: 'Stem’s server' },
            ...snap.devices.filter((d) => d.runsCodingAgents).map((d) => ({ value: d.id, label: d.label }))
          ]),
        read: (s) => codingWhere(chatCoding(s).target),
        save: (c, v, s) =>
          c.rpc('settings:updateChatFeatures', {
            coding: {
              allow: true,
              target: v === CHOOSE ? null : { agent: defaultAgent(s), ...(v === 'server' ? {} : { device: v }) }
            }
          })
      },
      {
        kind: 'dynamicChoice',
        key: 'chat-coding-agent',
        label: 'With agent',
        hint: 'Needs to be installed on that computer',
        visible: (s) => chatCoding(s).allow && chatCoding(s).target !== null,
        load: (c) => c.rpc('personas:agents').then((names) => names.map((n) => ({ value: n, label: n }))),
        read: (s) => chatCoding(s).target?.agent ?? '',
        save: (c, agent, s) =>
          c.rpc('settings:updateChatFeatures', {
            coding: { allow: true, target: { ...(chatCoding(s).target ?? {}), agent } }
          })
      },
      {
        kind: 'toggle',
        key: 'chat-images',
        label: 'Image generation',
        hint: 'Create pictures when you ask, with your ChatGPT subscription (every chat and persona)',
        // Absent on an older server = its default, on.
        read: (s) => s.chatFeatures?.images?.allow !== false,
        save: (c, allow) => c.rpc('settings:updateChatFeatures', { images: { allow } })
      },
      {
        kind: 'toggle',
        key: 'chat-computer',
        label: 'Computer control in chats',
        hint: 'Chats with no persona can drive a Mac when you ask',
        read: (s) => chatComputer(s).allow,
        save: (c, allow) =>
          c.rpc('settings:get').then((s) =>
            c.rpc('settings:updateChatFeatures', { computer: { ...chatComputer(s), allow } })
          )
      },
      {
        kind: 'dynamicChoice',
        key: 'chat-computer-mac',
        label: 'Control',
        hint: 'The Mac chats drive',
        visible: (s) => chatComputer(s).allow,
        load: (c) =>
          c.rpc('devices:list').then((snap) => [
            { value: CHOOSE, label: 'Let the model choose' },
            ...snap.devices.filter((d) => d.runsComputer).map((d) => ({ value: d.id, label: d.label }))
          ]),
        read: (s) => chatComputer(s).target?.device ?? CHOOSE,
        save: (c, v) =>
          c.rpc('settings:updateChatFeatures', {
            computer: { allow: true, target: v === CHOOSE ? null : { device: v } }
          })
      }
    ]
  },
  {
    // The desktop's Models tab, as rows: which model answers, and what the
    // background roles run on when they aren't left on their fall-through.
    title: 'Models',
    settings: [
      {
        kind: 'model',
        key: 'model-chat',
        label: 'Chat model',
        hint: 'The model you talk to',
        nullLabel: 'Stem default',
        read: (s) => s.defaults.model,
        save: (c, model) => c.rpc('settings:updateDefaults', { model })
      },
      {
        kind: 'model',
        key: 'model-background',
        label: 'Background work',
        hint: 'Quick tasks: chat subjects, the command safety check',
        nullLabel: 'Same as chat',
        read: (s) => s.defaults.backgroundModel,
        save: (c, backgroundModel) => c.rpc('settings:updateDefaults', { backgroundModel })
      },
      {
        kind: 'model',
        key: 'model-memory',
        label: 'Memory',
        hint: 'Distills what Stem remembers about you',
        nullLabel: 'Same as chat',
        read: (s) => s.memory.model,
        save: (c, model) => c.rpc('settings:updateMemory', { model })
      },
      {
        kind: 'model',
        key: 'model-skills',
        label: 'Skills',
        hint: 'Writes and curates skills',
        nullLabel: 'Same as chat',
        read: (s) => s.skills.model,
        save: (c, model) => c.rpc('settings:updateSkills', { model })
      }
    ]
  },
  {
    title: 'Keyboard',
    settings: [
      {
        kind: 'choice',
        key: 'escape-action',
        label: 'Escape while streaming',
        hint: 'Stop the reply and pull your message back to edit',
        // A phone has no Escape key; this is about the desk's keyboard.
        mobile: false,
        options: [
          { value: 'off', label: 'Off' },
          { value: 'single', label: 'Single' },
          { value: 'twoStage', label: 'Two-stage' }
        ],
        read: (s) => s.escapeAction,
        save: (c, v) => c.rpc('settings:updateEscapeAction', v as EscapeAction)
      }
    ]
  },
  {
    title: 'Quick Chat',
    settings: [
      {
        kind: 'toggle',
        key: 'qc-finish-sound',
        label: 'Finish sound',
        hint: 'Chime when a Quick Chat reply lands',
        // Quick Chat is the desktop overlay; the phone has no pill to chime.
        mobile: false,
        read: (s) => s.quickChat.finishSound,
        save: (c, finishSound) => c.rpc('settings:updateQuickChat', { finishSound })
      }
    ]
  }
];

/**
 * The groups as the phone shows them: settings that didn't opt out, groups that
 * still have any. This is the single place `mobile` is enforced.
 */
export function mobileGroups(): SettingsGroup[] {
  return SETTINGS_GROUPS.map((g) => ({
    ...g,
    settings: g.settings.filter((s) => s.mobile !== false)
  })).filter((g) => g.settings.length > 0);
}
