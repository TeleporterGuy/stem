import { describe, expect, it } from 'vitest';
import type { Persona } from '../../src/shared/types';
import { personaTurnFields } from '../../src/server/workspace/persona-turn';
import { savePersonaNote, saveStandingAnswer } from '../../src/server/workspace/persona-memory';

// The one builder every persona surface (mail, scheduler, client chats) uses:
// what a persona row contributes to a StartTurnInput.

const base: Persona = { id: 'p-turn', name: 'Turn', prompt: 'You are Turn.' };

describe('personaTurnFields', () => {
  it('carries the pins, the recall flag and a (possibly empty) notes index for a memory-owning persona', async () => {
    const fields = await personaTurnFields({
      ...base,
      model: 'prov/m',
      effort: 'high',
      recall: false
    });
    expect(fields.model).toBe('prov/m');
    expect(fields.effort).toBe('high');
    expect(fields.persona).toEqual({
      id: 'p-turn',
      prompt: 'You are Turn.',
      notes: [],
      recall: false
    });
  });

  it('carries the harness pin and standing answers (whole, no notes index) for a code persona', async () => {
    const harness = { agent: 'claude', cwd: '/repo' };
    const coder = { ...base, id: 'p-coder', harness };
    const empty = await personaTurnFields(coder);
    // A relay reads no notes index — it has no read_notes — but its standing
    // answers ride whole, present-but-empty so the preamble states the rule.
    expect(empty.persona).toEqual({ id: 'p-coder', prompt: 'You are Turn.', harness, answers: [] });
    await saveStandingAnswer('p-coder', 'Should I deploy?', 'Yes, always.');
    const fields = await personaTurnFields(coder);
    expect(fields.persona.notes).toBeUndefined();
    expect(fields.persona.answers).toEqual([{ title: 'Should I deploy?', body: 'Yes, always.' }]);
    // Answers switched off (memory: false) or a chat surface (notes: false): nothing rides.
    expect((await personaTurnFields({ ...coder, memory: false })).persona.answers).toBeUndefined();
    expect((await personaTurnFields(coder, { notes: false })).persona.answers).toBeUndefined();
  });

  it('lists the persona’s notes newest first, and omits the index for personas without a memory', async () => {
    const note = await savePersonaNote('p-turn', { title: 'A lesson', body: 'Body.' }, 'tool');
    expect((await personaTurnFields(base)).persona.notes).toEqual([{ id: note.id, title: 'A lesson' }]);
    // notes: false skips the store read where nothing renders the index.
    expect((await personaTurnFields(base, { notes: false })).persona.notes).toBeUndefined();
    // Memory switched off, or an agent-made helper: no index, so no remember_note pitch.
    expect((await personaTurnFields({ ...base, memory: false })).persona.notes).toBeUndefined();
    expect((await personaTurnFields({ ...base, createdBy: 'orchestrator' })).persona.notes).toBeUndefined();
    // Absent knobs stay absent rather than becoming undefined keys.
    const plain = await personaTurnFields({ ...base, memory: false });
    expect(plain).toEqual({ persona: { id: 'p-turn', prompt: 'You are Turn.' } });
  });
});
