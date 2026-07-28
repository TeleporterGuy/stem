// A minimal QR encoder, byte mode only.
//
// This exists for exactly one reason: the Settings pairing panel needs to put a
// URL on screen that a phone camera can read, and Stem takes no dependency it
// doesn't have to. QR is a fully specified algorithm (ISO/IEC 18004) with a
// small, testable core, so a self-contained encoder is cheaper than a package.
//
// Scope is deliberately narrow — byte mode, versions 1-20, all four error
// correction levels. Numeric/alphanumeric/Kanji modes would only shrink a code
// nobody is retyping, and versions above 20 hold 666 data codewords at level M,
// which is several times any pairing URL. Anything longer is refused loudly
// rather than silently truncated.
//
// The implementation follows the spec's own structure: encode the data into
// codewords, split into blocks and append Reed-Solomon parity, interleave, draw
// the function patterns, snake the data through what's left, then pick the mask
// that scores best under the spec's four penalty rules. Correctness is pinned in
// tests/unit/qr.test.ts by comparing whole matrices against codes produced by
// macOS CoreImage's own encoder.

export type QrEcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrCode {
  /** Module count per side, 21 + 4·(version−1). Excludes the quiet zone. */
  readonly size: number;
  /** The chosen symbol version (1-20). */
  readonly version: number;
  readonly ecLevel: QrEcLevel;
  /** The mask pattern (0-7) that scored lowest. */
  readonly mask: number;
  /** Row-major modules; true = dark. Indexed `[y][x]`. */
  readonly modules: readonly boolean[][];
}

export interface QrOptions {
  /** Error correction level. M is the default: readable, still compact. */
  ecLevel?: QrEcLevel;
  /** Smallest version to consider — raise it to force a chunkier code. */
  minVersion?: number;
  /**
   * Pin the mask pattern (0-7) instead of letting the penalty rules pick. Only
   * the tests need this: it is how a symbol is compared module-for-module
   * against a reference encoder that made its own choice.
   */
  mask?: number;
}

/** Highest version this encoder builds. See the module comment. */
export const QR_MAX_VERSION = 20;

// ---- spec tables ----

/**
 * Error-correction codewords per block, by level and version. Straight out of
 * ISO/IEC 18004 table 9; index 0 is padding so versions index naturally.
 */
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcLevel, readonly number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28]
};

/** Number of error-correction blocks, by level and version (same table). */
const NUM_EC_BLOCKS: Record<QrEcLevel, readonly number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25]
};

/** The two-bit level indicator that goes into the format information. */
const EC_FORMAT_BITS: Record<QrEcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Penalty weights for the four mask-evaluation rules (spec table 11). */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/**
 * Total data modules in a symbol, before subtracting error correction. Derived
 * rather than tabulated: the whole grid minus the finder/timing/format regions,
 * minus the alignment patterns (which the timing rows partly overlap, hence the
 * closed form), minus the version blocks from version 7 on.
 */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Total codewords in a symbol (data + error correction). */
function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

/** Data codewords available at this version and level. */
function dataCodewords(version: number, ecLevel: QrEcLevel): number {
  return totalCodewords(version) - ECC_CODEWORDS_PER_BLOCK[ecLevel][version] * NUM_EC_BLOCKS[ecLevel][version];
}

/**
 * Centre coordinates of the alignment patterns. The first is always 6 (sharing
 * the timing row); the rest are spaced evenly back from `size - 7`, with the
 * step rounded up to an even number so every centre lands on a light timing
 * module.
 */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const size = version * 4 + 17;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- GF(256) and Reed-Solomon ----

// The field is GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11D), the one QR
// specifies. Multiplication is done the schoolbook way rather than through log
// tables: the polynomials here are at most 30 terms, so clarity wins.

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    // Double (which is a shift plus the reduction), then add in `x` if this bit
    // of `y` is set. Addition in GF(2^n) is XOR.
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/**
 * The divisor polynomial for `degree` error-correction codewords: the product of
 * (x − α^i) for i in [0, degree). Returned with the leading 1 implicit, highest
 * power first, which is the shape the remainder loop below wants.
 */
function eccDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error-correction codewords for one block: data polynomial mod divisor. */
function eccRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

// ---- bit assembly ----

class BitBuffer {
  readonly bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/**
 * Data codewords for `bytes` at this version: mode indicator, character count,
 * the payload, a terminator, then the spec's alternating pad bytes. The count
 * indicator widens from 8 to 16 bits at version 10, which is why the version has
 * to be settled before the bit stream is built.
 */
function encodeDataCodewords(bytes: Uint8Array, version: number, ecLevel: QrEcLevel): number[] {
  const capacityBits = dataCodewords(version, ecLevel) * 8;
  const bb = new BitBuffer();
  bb.append(0b0100, 4); // byte mode
  bb.append(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) bb.append(b, 8);

  // Terminator: up to four zero bits, short if the symbol is nearly full.
  bb.append(0, Math.min(4, capacityBits - bb.bits.length));
  // Then to a byte boundary, then 0xEC/0x11 forever — a fixed, high-contrast
  // filler the spec picked so an empty tail doesn't read as a blank region.
  bb.append(0, (8 - (bb.bits.length % 8)) % 8);
  for (let pad = 0xec; bb.bits.length < capacityBits; pad ^= 0xec ^ 0x11) bb.append(pad, 8);

  const codewords: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

/**
 * Split the data into blocks, compute each block's parity, and interleave both
 * halves. Interleaving is what makes the error correction useful in practice: a
 * thumb over one corner damages a few codewords of every block rather than
 * destroying one block outright.
 */
function interleaveBlocks(data: readonly number[], version: number, ecLevel: QrEcLevel): number[] {
  const numBlocks = NUM_EC_BLOCKS[ecLevel][version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ecLevel][version];
  const rawTotal = totalCodewords(version);
  // The blocks are as equal as they can be; the remainder go one codeword longer,
  // and those long blocks come last.
  const numShort = numBlocks - (rawTotal % numBlocks);
  const shortDataLen = Math.floor(rawTotal / numBlocks) - eccLen;

  const divisor = eccDivisor(eccLen);
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  for (let i = 0, offset = 0; i < numBlocks; i++) {
    const len = shortDataLen + (i < numShort ? 0 : 1);
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    eccBlocks.push(eccRemainder(block, divisor));
  }

  const result: number[] = [];
  for (let i = 0; i <= shortDataLen; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < eccLen; i++) {
    for (const block of eccBlocks) result.push(block[i]);
  }
  return result;
}

// ---- the symbol ----

class Symbol_ {
  readonly size: number;
  readonly modules: boolean[][];
  /** Modules owned by a function pattern; the data snake steps over these. */
  private readonly reserved: boolean[][];

  constructor(
    readonly version: number,
    readonly ecLevel: QrEcLevel
  ) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }

  drawFunctionPatterns(): void {
    // Timing patterns first: the finders overwrite their ends.
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [x, y] of [
      [3, 3],
      [this.size - 4, 3],
      [3, this.size - 4]
    ]) {
      this.drawFinder(x, y);
    }
    const positions = alignmentPositions(this.version);
    const last = positions.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        // The three corners are already finder patterns.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        this.drawAlignment(positions[i], positions[j]);
      }
    }
    // Reserve the format area now (with a placeholder); the real bits need the
    // mask, which isn't chosen until the data is in place.
    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  /** A finder plus its separator: 9×9 of concentric rings, by Chebyshev distance. */
  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /**
   * Format information: five bits of level + mask, extended to fifteen by a
   * BCH(15,5) code and XORed with a fixed mask so an all-zero format can't read
   * as blank. Written twice, so damage to one corner is survivable.
   */
  drawFormatBits(mask: number): void {
    const data = (EC_FORMAT_BITS[this.ecLevel] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;

    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true); // the always-dark module
  }

  /** Version information (version 7 and up): six bits under a BCH(18,6) code. */
  private drawVersionBits(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  /**
   * Lay the codewords out in the spec's boustrophedon: two-column strips walked
   * from the bottom-right corner, alternating direction, skipping column 6
   * (which is the vertical timing pattern) and every reserved module.
   */
  drawCodewords(codewords: readonly number[]): void {
    let i = 0;
    const totalBits = codewords.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.reserved[y][x] && i < totalBits) {
            this.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  /** XOR the data region with mask `n`. Applying it twice undoes it. */
  applyMask(n: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.reserved[y][x]) continue;
        let invert: boolean;
        switch (n) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /**
   * The spec's four penalty rules, summed. Lower is better: the encoder tries
   * every mask and keeps the least-penalised symbol, which is what stops a
   * payload from producing large blank fields or decoy finder patterns.
   */
  penaltyScore(): number {
    let result = 0;

    for (const horizontal of [true, false]) {
      for (let a = 0; a < this.size; a++) {
        let runColor = false;
        let runLength = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < this.size; b++) {
          const dark = horizontal ? this.modules[a][b] : this.modules[b][a];
          if (dark === runColor) {
            runLength++;
            // Rule 1: five in a row costs 3, and one more per extra module.
            if (runLength === 5) result += PENALTY_N1;
            else if (runLength > 5) result++;
          } else {
            this.addRunToHistory(runLength, history);
            // Rule 3 is scored on light runs only, so each finder-like sequence
            // is counted once as its trailing light run closes.
            if (!runColor) result += this.countFinderPatterns(history) * PENALTY_N3;
            runColor = dark;
            runLength = 1;
          }
        }
        result += this.terminateRunHistory(runColor, runLength, history) * PENALTY_N3;
      }
    }

    // Rule 2: every 2×2 block of one colour.
    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const color = this.modules[y][x];
        if (color === this.modules[y][x + 1] && color === this.modules[y + 1][x] && color === this.modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    // Rule 4: 10 points for each further 5% the dark proportion strays from
    // half. `k` is the smallest integer with (45−5k)% ≤ dark/total ≤ (55+5k)%;
    // it can't go negative, because the module count is odd and so dark/total
    // can never be exactly one half.
    let dark = 0;
    for (const row of this.modules) for (const m of row) if (m) dark++;
    const total = this.size * this.size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * PENALTY_N4;
  }

  /** Push a run length onto the six-deep history the rule-3 test looks back over. */
  private addRunToHistory(runLength: number, history: number[]): void {
    // The very first run is preceded by the quiet zone, which counts as light
    // for the "four-wide light area" half of the pattern.
    if (history[0] === 0) runLength += this.size;
    history.pop();
    history.unshift(runLength);
  }

  /** Close a line: flush the final run plus the quiet zone beyond it. */
  private terminateRunHistory(runColor: boolean, runLength: number, history: number[]): number {
    if (runColor) {
      this.addRunToHistory(runLength, history);
      runLength = 0;
    }
    this.addRunToHistory(runLength + this.size, history);
    return this.countFinderPatterns(history);
  }

  /**
   * How many 1:1:3:1:1 finder-like sequences with a four-wide light margin end
   * here — up to two, since the margin may sit on either side. The ratio is
   * scale-free, so a doubled-up imitation counts too.
   */
  private countFinderPatterns(history: readonly number[]): number {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    if (!core) return 0;
    return (history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  }
}

/** Smallest version that holds `byteLength` bytes at this level, or null. */
function chooseVersion(byteLength: number, ecLevel: QrEcLevel, minVersion: number): number | null {
  for (let version = Math.max(1, minVersion); version <= QR_MAX_VERSION; version++) {
    // 4 bits of mode + 8 or 16 bits of character count.
    const headerBits = 4 + (version < 10 ? 8 : 16);
    if (headerBits + byteLength * 8 <= dataCodewords(version, ecLevel) * 8) return version;
  }
  return null;
}

/**
 * Encode `text` (as UTF-8) into a QR symbol. Throws when the text is too long
 * for version 20 at the requested level — a caller showing a pairing URL should
 * treat that as a bug in what it built, not render a broken code.
 */
export function encodeQr(text: string, options: QrOptions = {}): QrCode {
  const ecLevel = options.ecLevel ?? 'M';
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length, ecLevel, options.minVersion ?? 1);
  if (version === null) {
    throw new Error(`${bytes.length} bytes does not fit a version-${QR_MAX_VERSION} QR code at level ${ecLevel}`);
  }

  const codewords = interleaveBlocks(encodeDataCodewords(bytes, version, ecLevel), version, ecLevel);
  const symbol = new Symbol_(version, ecLevel);
  symbol.drawFunctionPatterns();
  symbol.drawCodewords(codewords);

  // Try all eight masks and keep the best. Each is applied, scored, then undone
  // by re-applying it, so only one symbol is ever built.
  let bestMask = options.mask ?? 0;
  let bestScore = Infinity;
  if (options.mask === undefined) {
    for (let mask = 0; mask < 8; mask++) {
      symbol.applyMask(mask);
      symbol.drawFormatBits(mask);
      const score = symbol.penaltyScore();
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
      }
      symbol.applyMask(mask);
    }
  }
  symbol.applyMask(bestMask);
  symbol.drawFormatBits(bestMask);

  return { size: symbol.size, version, ecLevel, mask: bestMask, modules: symbol.modules };
}

/**
 * The dark modules as one SVG path, in a coordinate system of 1 unit per module
 * with `quietZone` units of margin. One path rather than a rect per module keeps
 * a version-10 code (3600 modules) from becoming 3600 DOM nodes.
 */
export function qrPathData(code: QrCode, quietZone = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y][x]) parts.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`);
    }
  }
  return parts.join('');
}
