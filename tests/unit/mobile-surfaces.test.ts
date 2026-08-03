// What the phone can DO once it is connected: capture a note instead of running
// a turn, answer the four approvals a turn can block on, attach a photo, and
// continue a thread started at the desk without silently changing its model.
//
// The transport itself is covered by mobile-client.test.ts; this is the layer
// above it. Everything here is driven through fakes — no socket, no Electron and
// no DOM (the vitest environment is Node), which is why the phone's decisions
// live in plain modules and the components only render them.

import { describe, expect, it } from 'vitest';
import type {
  ExecApprovalRequest,
  InstructionsProposal,
  McpAdminProposal,
  SkillProposal,
  ThreadTurnSettings,
  TurnAttachment
} from '../../src/shared/types';
import type { NoteFlash } from '../../src/renderer/noteMode';
import { classifyDraft, noteFlashText } from '../../src/renderer/mobile/notes';
import {
  createApprovalStore,
  headApproval,
  resolvedInstructionsText,
  type ApprovalApi
} from '../../src/renderer/mobile/approvals';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentProblem,
  encodedSize,
  fileToAttachment
} from '../../src/renderer/mobile/attachments';
import { mobileStartTurnInput } from '../../src/renderer/mobile/turn';

// ---- note mode ----

describe('note mode routing', () => {
  it('sends a note to memory, not to the backend', () => {
    expect(classifyDraft('//buy milk', { noteMode: false, hasAttachments: false })).toEqual({
      kind: 'note',
      body: 'buy milk'
    });
    expect(classifyDraft('/note buy milk', { noteMode: false, hasAttachments: false })).toEqual({
      kind: 'note',
      body: 'buy milk'
    });
    // Already in note mode (the composer consumed the prefix as it was typed).
    expect(classifyDraft('buy milk', { noteMode: true, hasAttachments: false })).toEqual({
      kind: 'note',
      body: 'buy milk'
    });
  });

  it('treats an ordinary question as a turn, even when it contains the trigger', () => {
    // The whole point of the start-of-draft rule: this must reach the model.
    expect(classifyDraft('what does // mean in Python?', { noteMode: false, hasAttachments: false })).toEqual({
      kind: 'turn',
      text: 'what does // mean in Python?'
    });
    expect(classifyDraft('open https://stem.test//docs', { noteMode: false, hasAttachments: false })).toMatchObject({
      kind: 'turn'
    });
    expect(classifyDraft('/notes are nice', { noteMode: false, hasAttachments: false })).toMatchObject({
      kind: 'turn'
    });
  });

  it('has nothing to send for an empty draft or a bare trigger', () => {
    expect(classifyDraft('', { noteMode: false, hasAttachments: false })).toEqual({ kind: 'none' });
    expect(classifyDraft('//', { noteMode: false, hasAttachments: false })).toEqual({ kind: 'none' });
    expect(classifyDraft('//   ', { noteMode: false, hasAttachments: false })).toEqual({ kind: 'none' });
    expect(classifyDraft('  ', { noteMode: true, hasAttachments: false })).toEqual({ kind: 'none' });
  });

  it('lets attachments alone be a turn', () => {
    expect(classifyDraft('', { noteMode: false, hasAttachments: true })).toEqual({ kind: 'turn', text: '' });
  });

  it('says something for every save outcome', () => {
    // A swallowed failure reads as a dead send button, so none of these may be
    // silent — and the four must not collapse into the same sentence.
    const outcomes: Exclude<NoteFlash, null>[] = ['saved', 'off', 'secret', 'error'];
    const said = outcomes.map((flash) => noteFlashText(flash));
    for (const text of said) expect(text && text.length).toBeGreaterThan(0);
    expect(new Set(said).size).toBe(outcomes.length);
    expect(noteFlashText('off')).toMatch(/memory is off/i);
    expect(noteFlashText('secret')).toMatch(/credential/i);
    expect(noteFlashText('error')).toMatch(/couldn|try again/i);
    expect(noteFlashText(null)).toBeNull();
  });
});

// ---- approvals ----

/** A bridge stand-in: the test pushes events and reads back what was answered. */
function fakeApprovalApi() {
  const listeners = new Map<string, Set<(payload: any) => void>>();
  const answered: Array<{ channel: string; args: unknown[] }> = [];
  const on =
    (channel: string) =>
    (listener: (payload: any) => void): (() => void) => {
      const set = listeners.get(channel) ?? new Set();
      listeners.set(channel, set);
      set.add(listener);
      return () => set.delete(listener);
    };

  const api: ApprovalApi = {
    onExecApproval: on('exec:approvalRequest'),
    onExecApprovalResolved: on('exec:approvalResolved'),
    onMcpAdminApproval: on('mcp:adminApproval'),
    onMcpAdminApprovalResolved: on('mcp:adminApprovalResolved'),
    onInstructionsApproval: on('instructions:approvalRequest'),
    onInstructionsApprovalResolved: on('instructions:approvalResolved'),
    onSkillApproval: on('skills:approvalRequest'),
    onSkillApprovalResolved: on('skills:approvalResolved'),
    respondExecApproval: async (id, decision) => {
      answered.push({ channel: 'exec:resolveApproval', args: [id, decision] });
    },
    respondMcpAdminApproval: async (id, accept) => {
      answered.push({ channel: 'mcp:adminDecision', args: [id, accept] });
    },
    respondInstructionsApproval: async (id, accept, surface, text) => {
      answered.push({ channel: 'instructions:resolveApproval', args: [id, accept, surface, text] });
    },
    respondSkillApproval: async (id, accept, skill) => {
      answered.push({ channel: 'skills:resolveApproval', args: [id, accept, skill] });
    }
  };

  return {
    api,
    answered,
    emit(channel: string, payload: unknown): void {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
    },
    listening: () => [...listeners.values()].reduce((n, set) => n + set.size, 0)
  };
}

const execRequest = (id: string): ExecApprovalRequest => ({
  id,
  threadId: 't-1',
  command: 'rm -rf build',
  cwd: '/tmp/project',
  prefixes: ['rm'],
  judgeVerdict: 'unsure'
});
const mcpProposal = (id: number): McpAdminProposal => ({ id, threadId: 't-1', action: 'add', name: 'weather' });
const instructionsProposal = (id: number): InstructionsProposal => ({
  id,
  threadId: 't-1',
  action: 'append',
  incomingText: 'Answer briefly.'
});
const skillProposal = (id: number): SkillProposal => ({
  id,
  threadId: 't-1',
  name: 'renew-transit-pass',
  description: 'Renew the monthly transit pass from the operator’s site.',
  body: '## When to use\nThe pass is expiring.\n',
  isPatch: false,
  origin: 'assistant'
});

describe('approvals on the phone', () => {
  it('raises a card from a pushed request', () => {
    const bridge = fakeApprovalApi();
    const store = createApprovalStore(bridge.api);
    const detach = store.attach();
    let renders = 0;
    store.subscribe(() => (renders += 1));

    expect(headApproval(store.get())).toBeNull();
    bridge.emit('exec:approvalRequest', execRequest('a1'));
    expect(headApproval(store.get())).toEqual({ kind: 'exec', request: execRequest('a1') });
    expect(renders).toBe(1);

    // The same request again (a reconnect replaying it) is not a second card.
    bridge.emit('exec:approvalRequest', execRequest('a1'));
    expect(store.get().exec).toHaveLength(1);
    expect(renders).toBe(1);
    detach();
  });

  it('retracts a card answered on the other surface', () => {
    const bridge = fakeApprovalApi();
    const store = createApprovalStore(bridge.api);
    const detach = store.attach();

    bridge.emit('exec:approvalRequest', execRequest('a1'));
    bridge.emit('mcp:adminApproval', mcpProposal(7));
    bridge.emit('instructions:approvalRequest', instructionsProposal(9));
    bridge.emit('skills:approvalRequest', skillProposal(11));

    // Answered at the desk: main broadcasts the resolution to every surface, and
    // the phone's card has to go with it — otherwise it sits there proposing a
    // decision that was already taken.
    bridge.emit('exec:approvalResolved', { id: 'a1' });
    expect(store.get().exec).toEqual([]);
    bridge.emit('mcp:adminApprovalResolved', { id: 7 });
    expect(store.get().mcp).toEqual([]);
    bridge.emit('instructions:approvalResolved', { id: 9 });
    expect(store.get().instructions).toEqual([]);
    // A skill approval also expires on its own timer, and the same event retracts it.
    bridge.emit('skills:approvalResolved', { id: 11 });
    expect(store.get().skills).toEqual([]);
    expect(headApproval(store.get())).toBeNull();

    // A resolution for something never queued (or already gone) changes nothing.
    const before = store.get();
    bridge.emit('exec:approvalResolved', { id: 'a1' });
    expect(store.get()).toBe(before);
    detach();
  });

  it('shows one card at a time, exec first, in arrival order', () => {
    const bridge = fakeApprovalApi();
    const store = createApprovalStore(bridge.api);
    const detach = store.attach();

    bridge.emit('skills:approvalRequest', skillProposal(11));
    bridge.emit('mcp:adminApproval', mcpProposal(7));
    bridge.emit('exec:approvalRequest', execRequest('a1'));
    bridge.emit('exec:approvalRequest', execRequest('a2'));

    // Exec holds a running turn open, so it is what unblocks the conversation.
    expect(headApproval(store.get())).toMatchObject({ kind: 'exec', request: { id: 'a1' } });
    bridge.emit('exec:approvalResolved', { id: 'a1' });
    expect(headApproval(store.get())).toMatchObject({ kind: 'exec', request: { id: 'a2' } });
    bridge.emit('exec:approvalResolved', { id: 'a2' });
    expect(headApproval(store.get())).toMatchObject({ kind: 'mcp', proposal: { id: 7 } });
    // Last even though it arrived first: a skill proposal blocks nothing on screen.
    bridge.emit('mcp:adminApprovalResolved', { id: 7 });
    expect(headApproval(store.get())).toMatchObject({ kind: 'skill', proposal: { id: 11 } });
    detach();
  });

  it('answers on the allowlisted channels and drops the card without waiting', async () => {
    const bridge = fakeApprovalApi();
    const store = createApprovalStore(bridge.api);
    const detach = store.attach();

    bridge.emit('exec:approvalRequest', execRequest('a1'));
    await store.resolveExec('a1', 'allowOnce');
    expect(bridge.answered).toEqual([{ channel: 'exec:resolveApproval', args: ['a1', 'allowOnce'] }]);
    // Removed locally: the phone's own stream may be down, and the queue has to
    // advance anyway.
    expect(store.get().exec).toEqual([]);

    bridge.emit('mcp:adminApproval', mcpProposal(7));
    await store.resolveMcp(7, false);
    expect(bridge.answered[1]).toEqual({ channel: 'mcp:adminDecision', args: [7, false] });
    expect(store.get().mcp).toEqual([]);

    bridge.emit('instructions:approvalRequest', instructionsProposal(9));
    await store.resolveInstructions(9, true, 'Answer briefly.');
    // 'main' always: Quick Chat is a desktop overlay the phone cannot see, so a
    // change made here is one that applies everywhere.
    expect(bridge.answered[2]).toEqual({
      channel: 'instructions:resolveApproval',
      args: [9, true, 'main', 'Answer briefly.']
    });
    expect(store.get().instructions).toEqual([]);

    bridge.emit('skills:approvalRequest', skillProposal(11));
    await store.resolveSkill(11, true, skillProposal(11));
    // The phone cannot edit a skill, so the proposal's own text is what goes back
    // — the desk's card is the surface that can rewrite one.
    expect(bridge.answered[3]).toEqual({
      channel: 'skills:resolveApproval',
      args: [
        11,
        true,
        {
          name: 'renew-transit-pass',
          description: 'Renew the monthly transit pass from the operator’s site.',
          body: '## When to use\nThe pass is expiring.\n'
        }
      ]
    });
    expect(store.get().skills).toEqual([]);
    detach();
  });

  it('keeps the card up when the answer fails', async () => {
    const bridge = fakeApprovalApi();
    bridge.api.respondExecApproval = async () => {
      throw new Error('Stem is unreachable');
    };
    const store = createApprovalStore(bridge.api);
    const detach = store.attach();
    bridge.emit('exec:approvalRequest', execRequest('a1'));

    await expect(store.resolveExec('a1', 'deny')).rejects.toThrow(/unreachable/);
    expect(store.get().exec).toHaveLength(1);
    detach();
  });

  it('stops listening on detach, and can be attached again', () => {
    const bridge = fakeApprovalApi();
    const store = createApprovalStore(bridge.api);
    const detach = store.attach();
    expect(bridge.listening()).toBe(8);

    detach();
    expect(bridge.listening()).toBe(0);
    bridge.emit('exec:approvalRequest', execRequest('a1'));
    expect(store.get().exec).toEqual([]);

    const again = store.attach();
    bridge.emit('exec:approvalRequest', execRequest('a1'));
    expect(store.get().exec).toHaveLength(1);
    again();
  });

  it('resolves the instructions text the same way the desktop card does', () => {
    expect(resolvedInstructionsText('append', 'Be brief.', 'Be kind.')).toBe('Be kind.\nBe brief.');
    expect(resolvedInstructionsText('append', 'Be brief.', '')).toBe('Be brief.');
    expect(resolvedInstructionsText('replace', 'Be brief.', 'Be kind.')).toBe('Be brief.');
    expect(resolvedInstructionsText('clear', '', 'Be kind.')).toBe('');
  });
});

// ---- attachments ----

const dataUrl = (mime: string, base64: string) => async () => `data:${mime};base64,${base64}`;

describe('attaching from the phone', () => {
  it('base64s a picked file into a sendable attachment', async () => {
    const att = await fileToAttachment(
      { name: 'photo.jpg', size: 3, type: 'image/jpeg' },
      dataUrl('image/jpeg', 'aGVsbG8=')
    );
    expect(att).toEqual({ name: 'photo.jpg', mime: 'image/jpeg', dataBase64: 'aGVsbG8=' });
  });

  it('falls back to the type the browser put on the data URL', async () => {
    // Safari hands back an empty File.type often enough to matter.
    const att = await fileToAttachment({ name: 'scan.pdf', size: 3, type: '' }, dataUrl('application/pdf', 'JVBER'));
    expect(att.mime).toBe('application/pdf');
    const unknown = await fileToAttachment({ name: 'x', size: 3, type: '' }, async () => 'data:;base64,QQ==');
    expect(unknown.mime).toBe('application/octet-stream');
  });

  it('refuses a file that read back empty instead of sending nothing', async () => {
    await expect(fileToAttachment({ name: 'photo.jpg', size: 3, type: 'image/jpeg' }, async () => '')).rejects.toThrow(
      /photo\.jpg/
    );
  });

  it('rejects an over-sized file in the picker, in words', () => {
    const ok = attachmentProblem({ name: 'photo.jpg', size: 4 * 1024 * 1024, type: 'image/jpeg' }, []);
    expect(ok).toBeNull();

    // The bridge caps the /rpc body at 25 MB and refuses on the declared
    // content-length: without this the send would fail as an opaque 413.
    const problem = attachmentProblem({ name: 'movie.mov', size: 40 * 1024 * 1024, type: 'video/quicktime' }, []);
    expect(problem).toMatch(/movie\.mov/);
    expect(problem).toMatch(/40 MB/);
    expect(problem).toMatch(/10 MB/);
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('counts what is already attached against the turn budget', () => {
    // Each of these passes on its own; together they would not fit in one body.
    const held: TurnAttachment[] = [
      { name: 'a.jpg', mime: 'image/jpeg', dataBase64: 'x'.repeat(encodedSize(9 * 1024 * 1024)) },
      { name: 'b.jpg', mime: 'image/jpeg', dataBase64: 'x'.repeat(encodedSize(4 * 1024 * 1024)) }
    ];
    expect(attachmentProblem({ name: 'c.jpg', size: 1024 * 1024, type: 'image/jpeg' }, held)).toBeNull();
    expect(attachmentProblem({ name: 'c.jpg', size: 9 * 1024 * 1024, type: 'image/jpeg' }, held)).toMatch(
      /too big to send/
    );
  });

  it('sizes base64 the way the wire does', () => {
    expect(encodedSize(3)).toBe(4);
    expect(encodedSize(4)).toBe(8);
    expect(encodedSize(1024 * 1024)).toBeGreaterThan(1024 * 1024);
  });
});

// ---- continuing a thread started at the desk ----

/** Fake bridge for the one member the turn builder reads. */
function fakeSettings(settings: ThreadTurnSettings | Error) {
  const asked: string[] = [];
  return {
    asked,
    api: {
      taskThreadSettings: async (threadId: string) => {
        asked.push(threadId);
        if (settings instanceof Error) throw settings;
        return settings;
      }
    }
  };
}

describe('startTurn input', () => {
  it('carries the thread’s own model when continuing an existing chat', async () => {
    // pi does not restore a session's model on switch_session, so a turn sent
    // without one would run a desk-started thread on the app default.
    const bridge = fakeSettings({ model: 'anthropic/claude-opus-4', effort: 'high' });
    const input = await mobileStartTurnInput({ text: 'and then?', threadId: 't-7', attachments: [] }, bridge.api);
    expect(input).toEqual({
      input: 'and then?',
      format: 'mdx',
      threadId: 't-7',
      model: 'anthropic/claude-opus-4',
      effort: 'high'
    });
    expect(bridge.asked).toEqual(['t-7']);
  });

  it('leaves a new chat on the backend default', async () => {
    const bridge = fakeSettings({ model: 'anthropic/claude-opus-4' });
    const input = await mobileStartTurnInput({ text: 'hello', threadId: null, attachments: [] }, bridge.api);
    expect(input).toEqual({ input: 'hello', format: 'mdx' });
    // Nothing to read: there is no thread yet, and the phone has no picker.
    expect(bridge.asked).toEqual([]);
  });

  it('omits what the thread never explicitly chose', async () => {
    const bridge = fakeSettings({});
    const input = await mobileStartTurnInput({ text: 'go on', threadId: 't-7', attachments: [] }, bridge.api);
    expect(input).toEqual({ input: 'go on', format: 'mdx', threadId: 't-7' });
  });

  it('still sends the turn when the settings read fails', async () => {
    const bridge = fakeSettings(new Error('Stem is unreachable'));
    const input = await mobileStartTurnInput({ text: 'go on', threadId: 't-7', attachments: [] }, bridge.api);
    expect(input).toEqual({ input: 'go on', format: 'mdx', threadId: 't-7' });
  });

  it('passes attachments through only when there are some', async () => {
    const bridge = fakeSettings({});
    const attachments: TurnAttachment[] = [{ name: 'photo.jpg', mime: 'image/jpeg', dataBase64: 'aGk=' }];
    const withFiles = await mobileStartTurnInput({ text: 'what is this?', threadId: null, attachments }, bridge.api);
    expect(withFiles.attachments).toEqual(attachments);
    const without = await mobileStartTurnInput({ text: 'hi', threadId: null, attachments: [] }, bridge.api);
    expect(without.attachments).toBeUndefined();
  });

  it('leaves webSearch and instructions to main', async () => {
    // backend:startTurn spreads the input and then overrides both from settings,
    // so the user's standing custom instructions already apply to a phone turn.
    const bridge = fakeSettings({});
    const input = await mobileStartTurnInput({ text: 'hi', threadId: 't-7', attachments: [] }, bridge.api);
    expect(input.webSearch).toBeUndefined();
    expect(input.instructions).toBeUndefined();
  });
});
