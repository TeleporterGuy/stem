import { describe, expect, it } from 'vitest';
import { PIN_SLACK, isPinnedToBottom } from '../src/ui/scroll';

const at = (offsetY: number): Parameters<typeof isPinnedToBottom>[0] => ({
  offsetY,
  layoutHeight: 600,
  contentHeight: 2000
});

describe('isPinnedToBottom', () => {
  it('follows the stream at the bottom and stops the moment the user reads above it', () => {
    expect(isPinnedToBottom(at(1400))).toBe(true);
    expect(isPinnedToBottom(at(900))).toBe(false);
  });

  it('tolerates the few points a layout change or a fractional offset costs', () => {
    expect(isPinnedToBottom(at(1400 - PIN_SLACK))).toBe(true);
    expect(isPinnedToBottom(at(1400 - PIN_SLACK - 1))).toBe(false);
  });

  it('counts overscroll as the bottom, because rubber-banding is not a scroll away', () => {
    expect(isPinnedToBottom(at(1480))).toBe(true);
  });

  it('counts a transcript shorter than the screen as already at its own bottom', () => {
    expect(isPinnedToBottom({ offsetY: 0, layoutHeight: 600, contentHeight: 200 })).toBe(true);
  });
});
