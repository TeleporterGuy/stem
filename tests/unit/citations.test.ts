// Leaked web-search citation markers (see src/shared/citations.ts). Delimiters
// are built from char codes so no invisible PUA characters live in this source.
import { describe, expect, it } from 'vitest';
import { stripCiteMarkers } from '../../src/shared/citations';

const E200 = String.fromCharCode(0xe200); // marker start
const E201 = String.fromCharCode(0xe201); // marker end
const E202 = String.fromCharCode(0xe202); // id separator

describe('stripCiteMarkers', () => {
  it('removes a complete leaked marker (the shape observed in real sessions)', () => {
    const text = `odpisuje dva roky. ${E200}cite${E202}turn871848search0${E202}turn231504search0${E201}\n\nPri novom aute`;
    expect(stripCiteMarkers(text)).toBe('odpisuje dva roky. \n\nPri novom aute');
  });

  it('removes several markers in one message', () => {
    const m1 = `${E200}cite${E202}turn268779search1${E201}`;
    const m2 = `${E200}cite${E202}turn268779search3${E201}`;
    expect(stripCiteMarkers(`a ${m1} b ${m2} c`)).toBe('a  b  c');
  });

  it('removes an unterminated marker at a streaming tail', () => {
    expect(stripCiteMarkers(`kurz je 24,20 CZK. ${E200}cite${E202}turn12`)).toBe('kurz je 24,20 CZK. ');
  });

  it('removes stray orphaned delimiters', () => {
    expect(stripCiteMarkers(`a${E202}b${E201}c`)).toBe('abc');
  });

  it('returns clean text unchanged', () => {
    const clean = 'plain **markdown** with a [link](https://example.com) and unicode: čšž €';
    expect(stripCiteMarkers(clean)).toBe(clean);
  });
});
