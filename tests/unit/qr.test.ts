// The QR encoder behind the Settings pairing panel (src/renderer/ui/qr.ts).
//
// A hand-rolled implementation of a published algorithm needs vectors it did not
// produce itself, so this file grounds it two ways:
//
//  1. Whole reference symbols from macOS CoreImage's own QR encoder
//     (tests/fixtures/qr-vectors.json), compared module for module across
//     versions 1-11 and all four error-correction levels. Where CoreImage's mask
//     choice matches Stem's, the auto-selected symbol is compared too.
//  2. The spec's published byte-mode capacity table, all 20 supported versions ×
//     4 levels. Capacity is derived here from the error-correction block tables,
//     so a single wrong entry in either table shows up as a wrong version.
//
// Between them, every table and every stage of the pipeline (bit stream, block
// split, Reed-Solomon parity, interleave, function patterns, version and format
// information, data placement, mask selection) is pinned.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeQr, qrPathData, QR_MAX_VERSION, type QrCode, type QrEcLevel } from '../../src/renderer/ui/qr';

interface QrVector {
  text: string;
  ecLevel: QrEcLevel;
  version: number;
  mask: number;
  /** Whether Stem's own penalty-driven mask choice agrees with CoreImage's. */
  autoMask: boolean;
  rows: string[];
}

const vectors = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../fixtures/qr-vectors.json', import.meta.url)), 'utf8')
  ) as { vectors: QrVector[] }
).vectors;

/** The symbol as one string per row, '1' = dark — the fixtures' own shape. */
function rowsOf(code: QrCode): string[] {
  return code.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
}

describe('reference symbols from CoreImage', () => {
  it('covers a spread of versions and levels', () => {
    // A regression guard on the fixtures themselves: losing the large versions
    // would quietly stop testing the 16-bit character count and version bits.
    expect(vectors.length).toBeGreaterThanOrEqual(11);
    expect(new Set(vectors.map((v) => v.ecLevel))).toEqual(new Set(['L', 'M', 'Q', 'H']));
    expect(Math.max(...vectors.map((v) => v.version))).toBeGreaterThanOrEqual(10);
    expect(vectors.some((v) => v.autoMask)).toBe(true);
  });

  for (const v of vectors) {
    it(`matches version ${v.version} level ${v.ecLevel} mask ${v.mask} (${v.text.length} bytes)`, () => {
      const code = encodeQr(v.text, { ecLevel: v.ecLevel, mask: v.mask });
      expect(code.version).toBe(v.version);
      expect(code.size).toBe(v.rows.length);
      expect(rowsOf(code)).toEqual(v.rows);
    });
  }

  for (const v of vectors.filter((x) => x.autoMask)) {
    it(`picks mask ${v.mask} unprompted for version ${v.version} level ${v.ecLevel}`, () => {
      const code = encodeQr(v.text, { ecLevel: v.ecLevel });
      expect(code.mask).toBe(v.mask);
      expect(rowsOf(code)).toEqual(v.rows);
    });
  }
});

// Byte-mode capacity in characters, versions 1-20, from ISO/IEC 18004 table 7.
// The encoder never reads these: it computes capacity from the block tables, so
// agreement here means both block tables are right for all 80 combinations.
const BYTE_CAPACITY: Record<QrEcLevel, readonly number[]> = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292, 322, 364, 394, 442, 482],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220, 250, 280, 310, 338, 382]
};

describe('capacity', () => {
  for (const level of ['L', 'M', 'Q', 'H'] as QrEcLevel[]) {
    it(`fills each version exactly at level ${level}`, () => {
      const chosen = BYTE_CAPACITY[level].map((cap) => encodeQr('x'.repeat(cap), { ecLevel: level }).version);
      expect(chosen).toEqual(BYTE_CAPACITY[level].map((_, i) => i + 1));
    });

    it(`spills to the next version one byte over, at level ${level}`, () => {
      // One byte past each version's capacity must land on the next version —
      // which also proves the capacities are tight, not merely sufficient.
      for (let version = 1; version < QR_MAX_VERSION; version++) {
        const code = encodeQr('x'.repeat(BYTE_CAPACITY[level][version - 1] + 1), { ecLevel: level });
        expect(code.version).toBe(version + 1);
      }
    });
  }

  it('counts UTF-8 bytes, not characters', () => {
    // 'é' is two bytes, so 8 of them fill level H's 7-byte version 1 and spill.
    expect(encodeQr('é'.repeat(3), { ecLevel: 'H' }).version).toBe(1);
    expect(encodeQr('é'.repeat(4), { ecLevel: 'H' }).version).toBe(2);
  });

  it('refuses a payload larger than the largest supported version', () => {
    const tooBig = 'x'.repeat(BYTE_CAPACITY.M[QR_MAX_VERSION - 1] + 1);
    expect(() => encodeQr(tooBig, { ecLevel: 'M' })).toThrow(/does not fit a version-20 QR code/);
    // …and still fits at level L, which spends fewer codewords on parity.
    expect(encodeQr(tooBig, { ecLevel: 'L' }).version).toBe(18);
  });

  it('honours a version floor', () => {
    expect(encodeQr('Stem').version).toBe(1);
    expect(encodeQr('Stem', { minVersion: 6 }).version).toBe(6);
  });
});

describe('symbol structure', () => {
  /** Every function pattern a decoder locks onto, checked on a fresh symbol. */
  function structureProblems(code: QrCode): string[] {
    const problems: string[] = [];
    const m = code.modules;
    const size = code.size;
    if (size !== code.version * 4 + 17) problems.push(`size ${size} does not match version ${code.version}`);

    // The three finders: 7×7 concentric rings, dark-light-dark.
    for (const [ox, oy] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7]
    ]) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          const expected = ring !== 2;
          if (m[oy + dy][ox + dx] !== expected) problems.push(`finder at ${ox},${oy} wrong at ${dx},${dy}`);
        }
      }
    }
    // Timing patterns: alternating, starting dark, between the finders.
    for (let i = 8; i < size - 8; i++) {
      if (m[6][i] !== (i % 2 === 0)) problems.push(`horizontal timing wrong at ${i}`);
      if (m[i][6] !== (i % 2 === 0)) problems.push(`vertical timing wrong at ${i}`);
    }
    // The module the spec fixes dark, below the top-left finder's format strip.
    if (!m[size - 8][8]) problems.push('the always-dark module is light');
    return problems;
  }

  it('draws the function patterns at every version', () => {
    for (let version = 1; version <= QR_MAX_VERSION; version++) {
      // Fill the version exactly so no larger one is chosen.
      const code = encodeQr('x'.repeat(BYTE_CAPACITY.M[version - 1]), { ecLevel: 'M' });
      expect(structureProblems(code)).toEqual([]);
    }
  });

  it('is stable: the same input always gives the same symbol', () => {
    const url = 'https://macbook.example.ts.net/mobile.html#token=' + 'ab'.repeat(32);
    expect(rowsOf(encodeQr(url))).toEqual(rowsOf(encodeQr(url)));
  });

  it('defaults to level M', () => {
    expect(encodeQr('Stem').ecLevel).toBe('M');
  });
});

describe('svg path', () => {
  it('emits one unit square per dark module, offset by the quiet zone', () => {
    const code = encodeQr('Stem');
    const path = qrPathData(code, 4);
    const dark = code.modules.flat().filter(Boolean).length;
    expect(path.match(/M/g)?.length).toBe(dark);
    // The top-left finder's corner module sits at the quiet-zone origin.
    expect(path.startsWith('M4 4h1v1h-1z')).toBe(true);
  });

  it('takes a zero quiet zone', () => {
    expect(qrPathData(encodeQr('Stem'), 0).startsWith('M0 0h1v1h-1z')).toBe(true);
  });
});

describe('a pairing URL', () => {
  // The real payload: a MagicDNS host plus a 64-character hex token in the
  // fragment. It must stay comfortably inside a code a phone can read across a
  // desk, which in practice means a low version at a forgiving level.
  const url = `https://a-rather-long-machine-name.tailnet-example.ts.net/mobile.html#token=${'0f'.repeat(32)}`;

  it('fits a mid-range symbol at level M', () => {
    const code = encodeQr(url, { ecLevel: 'M' });
    expect(url.length).toBeGreaterThan(120);
    expect(code.version).toBeLessThanOrEqual(10);
    expect(code.size).toBeLessThanOrEqual(57);
  });
});
