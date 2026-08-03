import { describe, expect, it } from 'vitest';
import { detectLearnCommand } from '../../src/renderer/chat/Composer';

describe('detectLearnCommand', () => {
  it('matches a bare /learn with no focus', () => {
    expect(detectLearnCommand('/learn')).toEqual({ focus: '' });
  });

  it('takes the rest of the line as the focus', () => {
    expect(detectLearnCommand('/learn the retry loop')).toEqual({ focus: 'the retry loop' });
    expect(detectLearnCommand('/learn   spaced  ')).toEqual({ focus: 'spaced' });
  });

  it('never matches mid-message or on longer slash words', () => {
    expect(detectLearnCommand('tell me what /learn does')).toBeNull();
    expect(detectLearnCommand('/learned something')).toBeNull();
    expect(detectLearnCommand('/learnings')).toBeNull();
  });

  it('plain messages pass through untouched', () => {
    expect(detectLearnCommand('what is the weather?')).toBeNull();
    expect(detectLearnCommand('/ learn spaced out')).toBeNull();
  });
});
