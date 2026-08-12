// The chat timeline folds each scheduled run under a collapsed "Scheduled run"
// row. A silent run stays fully folded — it's an audit trail. But a run that
// called notify_user asked for the user's attention, so its final reply must
// surface as a normal message (`alert`), leaving only the prompt and the
// intermediate work behind the fold. Otherwise an inbox-mode notification lands
// the user in a chat where the very thing that alerted them is hidden.
import { describe, expect, it } from 'vitest';
import { buildTimelineGroups } from '../../src/renderer/chat/ChatView';
import type { ChatMessage } from '../../src/shared/types';

let seq = 0;
const msg = (over: Partial<ChatMessage> & Pick<ChatMessage, 'role'>): ChatMessage => ({
  id: `m${++seq}`,
  content: 'text',
  ...over
});

const scheduledPrompt = () => msg({ role: 'user', scheduled: { at: '2026-08-12T09:00:00' } });
const notifyReply = (over: Partial<ChatMessage> = {}) =>
  msg({
    role: 'assistant',
    activity: [{ id: 't1', kind: 'tool', type: 'mcpToolCall', name: 'notify_user', status: 'ok' }],
    ...over
  });

describe('buildTimelineGroups', () => {
  it('keeps ordinary messages as single-item groups', () => {
    const groups = buildTimelineGroups([msg({ role: 'user' }), msg({ role: 'assistant' })]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.scheduledAt && g.items.length === 1)).toBe(true);
  });

  it('folds a silent run — prompt and reply — entirely, with no alert', () => {
    const groups = buildTimelineGroups([scheduledPrompt(), msg({ role: 'assistant' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].scheduledAt).toBe('2026-08-12T09:00:00');
    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].alert).toBeUndefined();
  });

  it('surfaces the reply of a run that called notify_user, folding only the prompt', () => {
    const reply = notifyReply();
    const groups = buildTimelineGroups([scheduledPrompt(), reply]);
    expect(groups).toHaveLength(1);
    expect(groups[0].alert).toBe(reply);
    expect(groups[0].items.map((m) => m.role)).toEqual(['user']);
  });

  it('surfaces only the LAST reply of a notified run; earlier turns stay folded', () => {
    const early = notifyReply();
    const final = msg({ role: 'assistant' });
    const groups = buildTimelineGroups([scheduledPrompt(), early, msg({ role: 'system' }), final]);
    expect(groups[0].alert).toBe(final);
    expect(groups[0].items).toContain(early);
    expect(groups[0].items).not.toContain(final);
  });

  it('scopes the notify to its own run — a later silent run stays folded', () => {
    const groups = buildTimelineGroups([
      scheduledPrompt(),
      notifyReply(),
      scheduledPrompt(),
      msg({ role: 'assistant' })
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].alert).toBeDefined();
    expect(groups[1].alert).toBeUndefined();
  });

  it('ends the run fold at the next interactive user message', () => {
    const followUp = msg({ role: 'user' });
    const groups = buildTimelineGroups([scheduledPrompt(), notifyReply(), followUp]);
    expect(groups).toHaveLength(2);
    expect(groups[1].items).toEqual([followUp]);
  });
});
