// Real generation speed (the tok/s on an answer). Each model call in a turn is
// timed off pi's own stream events and paired with that call's exact output
// token count, then the turn sums both. A tool turn is several calls; tool
// execution sits between them, outside every call, so it never dilutes the rate.
//
// The phase split (thinkingMs/answerMs) can't do this: it covers no call but the
// last for usage, and it books a model's silent thinking as wait time while its
// tokens still count, which read GPT turns far too fast.

import type { PiEvent } from './rpc';

/** One turn's timed model calls, plus the call in flight. Owned by TurnContext. */
export interface GenerationClock {
  /** Output tokens of the calls timed so far. */
  tokens: number;
  /** Stream time of those calls, ms. */
  ms: number;
  /** The call in flight: its stream opened (provider answered), its first token landed. */
  openAt?: number;
  firstAt?: number;
}

export function newGenerationClock(): GenerationClock {
  return { tokens: 0, ms: 0 };
}

interface StreamMessage {
  role?: string;
  stopReason?: string;
  usage?: { output?: number; reasoning?: number };
}

const TOKEN_DELTAS = new Set(['text_delta', 'thinking_delta', 'toolcall_delta']);

/** Advance the clock by one raw pi event, received at `now`. */
export function trackGeneration(clock: GenerationClock, ev: PiEvent, now: number): void {
  // pi's RPC drops `message` from message_update (it is always the assistant's).
  if (ev.type === 'message_update') {
    const kind = (ev.assistantMessageEvent as { type?: string } | undefined)?.type;
    if (clock.firstAt === undefined && kind && TOKEN_DELTAS.has(kind)) clock.firstAt = now;
    return;
  }
  const message = ev.message as StreamMessage | undefined;
  if (message?.role !== 'assistant') return;
  if (ev.type === 'message_start') {
    clock.openAt = now;
    clock.firstAt = undefined;
    return;
  }
  if (ev.type !== 'message_end') return;
  const { openAt, firstAt } = clock;
  clock.openAt = clock.firstAt = undefined;
  // A failed call's usage is partial or absent, and pi replays it on retry.
  if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
  const tokens = message.usage?.output ?? 0;
  // A call that reports reasoning tokens thought before its first visible delta
  // (GPT's hidden reasoning, Claude's summarized thinking). Those tokens are in
  // `output`, so the clock starts at the stream's open, not the first delta. The
  // cost: it also holds the provider's prompt read, so a long context reads a
  // little slow. Every other call is timed first token to last.
  const start = (message.usage?.reasoning ?? 0) > 0 ? openAt : (firstAt ?? openAt);
  if (start === undefined || tokens <= 0) return;
  const ms = now - start;
  // Delivered in one burst: the tokens carry no rate, and adding them with no
  // time would inflate the turn's.
  if (ms <= 0) return;
  clock.tokens += tokens;
  clock.ms += ms;
}
