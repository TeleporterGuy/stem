import type {
  ActivityItem,
  AgentMessageDeltaParams,
  BackendEventEnvelope,
  ChatMessage,
  ItemEventParams,
  MessageMeta,
  ThreadStatus,
  TurnCompletedParams,
  TurnSourcesParams,
  TurnTiming,
  TurnTimingParams,
  TurnUsage,
  TurnUsageParams
} from '../shared/types';
import { agentMessageText } from '../shared/types';
import { activityLabel } from '../shared/activity';

// Everything about one chat's in-flight/visible state. Stored per thread id (plus
// the DRAFT slice in App) so multiple chats can run and stream at the same time.
export interface ThreadState {
  messages: ChatMessage[];
  running: boolean;
  streamingId: string | null;
  /** Label of the in-flight activity (tool/reasoning); null once text streams. */
  activity: string | null;
  /** Tool calls/web searches of the in-flight turn, in start order (activity rows). */
  activities: ActivityItem[];
  activeTurnId: string | null;
  /** Drives the status dot on the chat row. */
  status: ThreadStatus;
}

export const EMPTY_STATE: ThreadState = {
  messages: [],
  running: false,
  streamingId: null,
  activity: null,
  activities: [],
  activeTurnId: null,
  status: 'idle'
};

type TurnSettledMethod = 'turn/completed' | 'turn/failed' | 'turn/aborted';

// A dropped provider connection surfaces as a bare, alarming failure like
// "WebSocket error". The ChatGPT/codex transport is a WebSocket that pi does NOT
// auto-retry once streaming has begun (replaying could re-run tools it already
// executed — see openai-codex-responses' websocketStarted branch), so the turn
// just fails even though its tool calls (e.g. a scheduled reminder) already
// committed. Rewrite transport-class failures into copy that explains the drop
// AND reassures that already-completed work was saved — so the user neither
// assumes it failed nor blindly resends and repeats a side effect.
const TRANSPORT_ERROR =
  /websocket|socket hang ?up|econnreset|econnrefused|etimedout|network error|fetch failed|stream (?:closed|ended|error)|connection (?:closed|reset|refused|error)|terminated|premature close/i;

export function turnFailureMessage(error?: string): string {
  const trimmed = error?.trim();
  if (!trimmed) return 'The reply failed. Try sending the message again.';
  if (TRANSPORT_ERROR.test(trimmed)) {
    return `The connection to the model dropped before it finished replying (${trimmed}). Anything it already did this turn — like scheduling a task — was saved, so check the Tasks tab before resending to avoid repeating it.`;
  }
  return trimmed;
}

interface ApplyBackendEventOptions {
  turnMeta?: ReadonlyMap<string, MessageMeta>;
  settledStatus?: (method: TurnSettledMethod, threadId: string) => ThreadStatus;
}

export function backendEventThreadId(event: BackendEventEnvelope): string | undefined {
  return (event.params as { threadId?: string } | undefined)?.threadId;
}

/**
 * Label for the "working" line given the in-flight activity list: the single running
 * tool's label, or a count when several run at once (pi executes a turn's tool calls
 * in parallel). Null when no tool is running.
 */
function runningLabel(activities: ActivityItem[]): string | null {
  const running = activities.filter((a) => a.status === 'running');
  if (!running.length) return null;
  if (running.length > 1) return `Running ${running.length} tools…`;
  return activityLabel(running[0].type, running[0].name, running[0].detail);
}

/** Copy the live activity list onto the turn's assistant bubble (if it exists yet). */
function stampActivity(messages: ChatMessage[], turnId: string, activities: ActivityItem[]): ChatMessage[] {
  if (!activities.length) return messages;
  const id = `assistant-${turnId}`;
  const idx = messages.findIndex((m) => m.id === id);
  if (idx === -1) return messages;
  return messages.map((m, i) => (i === idx ? { ...m, activity: activities } : m));
}

export function applyBackendEventToThread(
  state: ThreadState,
  event: BackendEventEnvelope,
  options: ApplyBackendEventOptions = {}
): ThreadState | null {
  switch (event.method) {
    case 'item/agentMessage/delta': {
      const p = event.params as AgentMessageDeltaParams;
      const id = `assistant-${p.turnId}`;
      const meta = options.turnMeta?.get(p.turnId);
      const idx = state.messages.findIndex((m) => m.id === id);
      const messages =
        idx === -1
          ? [...state.messages, { id, role: 'assistant', content: p.delta, meta, turnId: p.turnId } as ChatMessage]
          : state.messages.map((m, i) => (i === idx ? { ...m, content: m.content + p.delta } : m));
      return {
        ...state,
        messages: stampActivity(messages, p.turnId, state.activities),
        running: true,
        streamingId: id,
        activity: null,
        status: 'running'
      };
    }
    case 'item/started': {
      const p = event.params as ItemEventParams;
      const type = p.item?.type;
      if (!type || type === 'agentMessage') return null;
      const label = activityLabel(type, p.item?.name, p.item?.detail);
      if (type === 'reasoning') return { ...state, activity: label };
      // A tool call (or teed native web search) becomes an activity row.
      const itemId = p.item.id;
      const activities = state.activities.some((a) => a.id === itemId)
        ? state.activities
        : [
            ...state.activities,
            {
              id: itemId,
              kind: type === 'webSearch' ? 'webSearch' : 'tool',
              type,
              name: p.item.name,
              detail: p.item.detail,
              status: 'running'
            } as ActivityItem
          ];
      return {
        ...state,
        activity: runningLabel(activities) ?? label,
        activities,
        messages: stampActivity(state.messages, p.turnId, activities)
      };
    }
    case 'item/completed': {
      const p = event.params as ItemEventParams;
      if (p.item?.type !== 'agentMessage') {
        // A tool call finished — flip its row's status.
        const idx = state.activities.findIndex((a) => a.id === p.item?.id);
        if (idx === -1) return null;
        const activities = state.activities.map((a, i) =>
          i === idx ? { ...a, status: p.item.status ?? 'ok', detail: p.item.detail ?? a.detail } : a
        );
        // Refresh the working label from whatever is still running; keep the last
        // label when nothing is (reasoning/answer events overwrite it as before).
        const activity = runningLabel(activities) ?? state.activity;
        return { ...state, activity, activities, messages: stampActivity(state.messages, p.turnId, activities) };
      }
      const id = `assistant-${p.turnId}`;
      const text = agentMessageText(p.item);
      const meta = options.turnMeta?.get(p.turnId);
      const idx = state.messages.findIndex((m) => m.id === id);
      const messages =
        idx === -1
          ? [...state.messages, { id, role: 'assistant', content: text, meta, turnId: p.turnId } as ChatMessage]
          : state.messages.map((m, i) =>
              i === idx ? { ...m, content: text || m.content, meta: m.meta ?? meta } : m
            );
      return { ...state, messages: stampActivity(messages, p.turnId, state.activities), streamingId: null };
    }
    case 'turn/sources': {
      const p = event.params as TurnSourcesParams;
      if (!p.sources?.length) return null;
      const id = `assistant-${p.turnId}`;
      const idx = state.messages.findIndex((m) => m.id === id);
      if (idx === -1) return null;
      return {
        ...state,
        messages: state.messages.map((m, i) => (i === idx ? { ...m, sources: p.sources } : m))
      };
    }
    case 'turn/timing': {
      const p = event.params as TurnTimingParams;
      const id = `assistant-${p.turnId}`;
      const idx = state.messages.findIndex((m) => m.id === id);
      if (idx === -1) return null; // errored/aborted turn with no assistant bubble
      const timing: TurnTiming = {
        totalMs: p.totalMs,
        thinkingMs: p.thinkingMs,
        toolMs: p.toolMs,
        answerMs: p.answerMs,
        ttftMs: p.sendToFirstTokenMs,
        buildMs: p.buildMs,
        recallMs: p.recall?.total ?? null
      };
      return { ...state, messages: state.messages.map((m, i) => (i === idx ? { ...m, timing } : m)) };
    }
    case 'turn/usage': {
      const p = event.params as TurnUsageParams;
      const id = `assistant-${p.turnId}`;
      const idx = state.messages.findIndex((m) => m.id === id);
      if (idx === -1) return null; // errored/aborted turn with no assistant bubble
      const usage: TurnUsage = {
        input: p.input,
        output: p.output,
        cacheRead: p.cacheRead,
        cacheWrite: p.cacheWrite,
        totalTokens: p.totalTokens,
        cost: p.cost
      };
      return { ...state, messages: state.messages.map((m, i) => (i === idx ? { ...m, usage } : m)) };
    }
    case 'turn/completed':
    case 'turn/failed':
    case 'turn/aborted': {
      const p = event.params as TurnCompletedParams;
      const method = event.method as TurnSettledMethod;
      // A failed turn carries its failure text — surface it as a system bubble
      // instead of silently stopping (auth expiry, provider errors, …).
      const settled =
        method === 'turn/failed'
          ? [
              ...stampActivity(state.messages, p.turn.id, state.activities),
              {
                id: `system-${p.turn.id}`,
                role: 'system' as const,
                content: turnFailureMessage(p.error)
              }
            ]
          : stampActivity(state.messages, p.turn.id, state.activities);
      return {
        ...state,
        // Stamp the final activity list onto the turn's bubble before clearing the
        // live list — settled rows render collapsed from the message itself.
        messages: settled,
        running: false,
        streamingId: null,
        activity: null,
        activities: [],
        activeTurnId: null,
        status: options.settledStatus?.(method, p.threadId) ?? 'idle'
      };
    }
    default:
      return null;
  }
}

export function applyProcessExitToThread(state: ThreadState): ThreadState {
  return {
    ...state,
    running: false,
    streamingId: null,
    activity: null,
    activities: [],
    activeTurnId: null,
    status: state.status === 'running' ? 'idle' : state.status
  };
}

export function appendSystemMessage(state: ThreadState, error: unknown): ThreadState {
  return {
    ...state,
    messages: [
      ...state.messages,
      { id: `system-${Date.now()}`, role: 'system', content: String(error instanceof Error ? error.message : error) }
    ],
    running: false,
    activeTurnId: null,
    status: 'error'
  };
}
