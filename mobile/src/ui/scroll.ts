// "Follow the stream, unless the user is reading something above it."
//
// A transcript that jumps to the bottom on every token is unreadable the moment
// you scroll up to check what a tool did; one that never jumps means watching a
// reply arrive off-screen. The rule both clients use is the same: keep it pinned
// while the viewport is at (or within a hair of) the bottom, and stop the instant
// it is not.
//
// SLACK is the whole subtlety. Momentum scrolling on iOS reports fractional
// offsets, a keyboard opening changes the layout height by a few points between
// frames, and content growing by one line while a scroll event is in flight
// leaves the numbers a few points apart on their own. An exact comparison would
// unpin the view for reasons the user had nothing to do with, and the failure
// looks like the app randomly deciding to stop following — the hardest kind of
// bug to report. A few dozen points of tolerance costs nothing: no real reading
// position is that close to the bottom by accident.

export interface ScrollMetrics {
  /** How far down the content the viewport currently is. */
  offsetY: number;
  /** The height of the visible area. */
  layoutHeight: number;
  /** The height of everything there is to scroll through. */
  contentHeight: number;
}

/** Points of tolerance — about one line of body text plus a margin. */
export const PIN_SLACK = 48;

export function isPinnedToBottom(metrics: ScrollMetrics, slack: number = PIN_SLACK): boolean {
  const distance = metrics.contentHeight - metrics.layoutHeight - metrics.offsetY;
  // Content shorter than the viewport has nothing to scroll and is therefore
  // always at its own bottom; overscroll makes `distance` negative, which is
  // still the bottom.
  return distance <= slack;
}
