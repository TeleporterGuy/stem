// Pure helpers for coding_agent turns: fold the acpx event stream into the
// little state the UI and the result text need, and render both. No I/O and no
// acpx import, so the same code serves the local host, the device host (whose
// events arrive over the wire), and unit tests.

/** The structural slice of acpx's AcpRuntimeEvent this module reads. */
export interface HarnessEvent {
  type: string;
  text?: string;
  stream?: string;
  tag?: string;
  toolCallId?: string;
  messageId?: string;
  status?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  locations?: Array<{ path?: string }>;
  cost?: { amount?: number; currency?: string };
}

export interface HarnessTurnSummary {
  /** The agent's end-turn reply (output stream only, thoughts dropped). */
  text: string;
  /**
   * Just the agent's last message: the output text after its last tool call
   * or message boundary. `text` runs every "Let me…" / "Waiting on agents…"
   * line of the turn together with the report; this is the report alone.
   */
  lastMessage: string;
  /** The messageId of the text `lastMessage` is collecting, when the adapter sends one. */
  lastMessageId?: string;
  /** A tool call came after `lastMessage`: the next text starts a new message. */
  messageClosed?: boolean;
  toolCalls: number;
  /** Paths the agent's tool calls named, deduped in first-seen order. */
  files: string[];
  /** Cumulative session cost in USD, as of the latest usage update. */
  costUsd?: number;
  /** What the agent is doing right now, for the live row. */
  currentTool?: string;
}

/** Adapters send a generic placeholder title on late tool_call updates. */
const GENERIC_TITLES = new Set(['tool call', 'Terminal']);

export function newTurnSummary(): HarnessTurnSummary {
  return { text: '', lastMessage: '', toolCalls: 0, files: [] };
}

/**
 * The agent's final message: `lastMessage` when the event stream gave one that
 * the host's own reply text actually ends with (a dropped event batch must not
 * truncate the report), else the whole reply.
 */
export function finalMessage(summary: HarnessTurnSummary): string {
  const last = summary.lastMessage.trim();
  const whole = summary.text.trim();
  return last && whole.endsWith(last) ? last : whole;
}

/** Fold one event into the summary (mutates and returns it). */
export function noteEvent(summary: HarnessTurnSummary, event: HarnessEvent): HarnessTurnSummary {
  if (event.type === 'text_delta') {
    if (event.stream !== 'thought' && typeof event.text === 'string') {
      summary.text += event.text;
      const newMessage =
        summary.messageClosed === true ||
        (event.messageId !== undefined && summary.lastMessageId !== undefined && event.messageId !== summary.lastMessageId);
      summary.lastMessage = newMessage ? event.text : summary.lastMessage + event.text;
      summary.messageClosed = false;
      if (event.messageId !== undefined) summary.lastMessageId = event.messageId;
    }
    return summary;
  }
  if (event.type === 'status') {
    if (event.tag === 'usage_update' && typeof event.cost?.amount === 'number') {
      summary.costUsd = event.cost.amount;
    }
    return summary;
  }
  if (event.type === 'tool_call') {
    if (event.tag === 'tool_call') {
      summary.toolCalls += 1;
      if (summary.lastMessage) summary.messageClosed = true;
    }
    for (const location of event.locations ?? []) {
      if (location?.path && !summary.files.includes(location.path)) summary.files.push(location.path);
    }
    const title = typeof event.title === 'string' ? event.title.trim() : '';
    if (title && !GENERIC_TITLES.has(title)) summary.currentTool = title;
    if (event.status === 'completed' || event.status === 'failed') summary.currentTool = undefined;
    return summary;
  }
  return summary;
}

/** "$0.42", with tenth-of-a-cent precision kept for sub-cent costs. */
export function formatCost(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.01 ? `$${costUsd.toFixed(3)}` : `$${costUsd.toFixed(2)}`;
}

/**
 * The live activity row: "claude: editing src/foo.ts · 12 tool calls · $0.40".
 * Every part after the agent name is optional, so an early row degrades to
 * just "claude: working".
 */
export function activityDetail(agent: string, summary: HarnessTurnSummary): string {
  const parts: string[] = [];
  parts.push(summary.currentTool ? `${agent}: ${clipLine(summary.currentTool, 60)}` : `${agent}: working`);
  if (summary.toolCalls > 0) parts.push(`${summary.toolCalls} tool call${summary.toolCalls === 1 ? '' : 's'}`);
  if (typeof summary.costUsd === 'number') parts.push(formatCost(summary.costUsd));
  return parts.join(' · ');
}

function clipLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Which agent conversation a call ran in: a new one (asked for, or none
 * remembered), the remembered one, or a new one because the host no longer
 * had the remembered one.
 */
export type SessionOutcome = 'new' | 'continued' | 'lost';

export interface HarnessResultInput {
  agent: string;
  summary: HarnessTurnSummary;
  status: 'ok' | 'failed' | 'cancelled';
  hostLabel: string;
  session?: SessionOutcome;
  error?: string;
  /** For a cancelled run: what stopped it, when it was not the user. */
  cancelReason?: string;
}

/**
 * The tool call's return text: the agent's reply first (it may be a question
 * the model must relay), then one bracketed bookkeeping line, then the
 * continuity note that tells the model how to keep the conversation going.
 */
export function formatRunResult(input: HarnessResultInput): string {
  const { agent, summary, status, hostLabel, session, error, cancelReason } = input;
  if (status === 'cancelled') {
    // Only a Stop the user pressed reads as theirs. Anything Stem did on its
    // own — a scheduler timeout, a deleted chat, a dead worker — is named, so
    // the model never tells the user they cancelled something they did not.
    const cause = cancelReason ? `stopped by Stem: ${cancelReason}` : 'cancelled by the user';
    return `The ${agent} run was ${cause}. The session survives: calling coding_agent again with the same agent and cwd continues the same conversation.`;
  }
  if (status === 'failed') {
    return `The ${agent} run failed on ${hostLabel}: ${error || 'unknown error'}`;
  }
  const stats: string[] = [agent, `on ${hostLabel}`];
  if (session === 'new') stats.push('new session');
  else if (session === 'continued') stats.push('continued session');
  else if (session === 'lost') stats.push('new session: the earlier one was lost, so the agent remembers none of it');
  if (summary.toolCalls > 0) stats.push(`${summary.toolCalls} tool call${summary.toolCalls === 1 ? '' : 's'}`);
  if (typeof summary.costUsd === 'number') stats.push(`session cost ${formatCost(summary.costUsd)}`);
  const files = summary.files.length ? `\nFiles touched: ${summary.files.join(', ')}` : '';
  const reply = finalMessage(summary) || '(the agent ended its turn without a reply)';
  return (
    `${reply}\n\n[${stats.join(' · ')}]${files}\n` +
    'This session continues: call coding_agent again with the same agent and cwd to send a follow-up ' +
    '(answer its questions yourself when the conversation gives you the answer; otherwise relay them to the user).'
  );
}
