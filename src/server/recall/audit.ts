// Shared phrasing for the activity feed's memory-write audit lines. The
// unattended writers (conversation distill, folder learn) both report WHAT they
// wrote, not just a count — the feed is the only place the user learns a
// background pass touched durable memory at all.

/**
 * Compress freshly written fact texts into an activity-feed detail: up to three
 * quoted, truncated statements plus a "+N more" tail. `expected` covers the rare
 * case where the created-at snapshot missed rows (re-upserts bump updated_at
 * only) — the count in the label must never understate what was written.
 */
export function summarizeFactTexts(facts: Array<{ text: string }>, expected: number): string {
  const clip = (t: string): string => (t.length > 70 ? `${t.slice(0, 67)}…` : t);
  const shown = facts.slice(0, 3).map((f) => `“${clip(f.text)}”`);
  const more = Math.max(expected, facts.length) - shown.length;
  if (shown.length === 0) return 'see the Facts tab';
  return more > 0 ? `${shown.join('; ')} +${more} more` : shown.join('; ');
}
