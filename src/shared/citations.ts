// OpenAI's native web search wraps inline citations in private-use-area
// delimiters: U+E200 <token> U+E202 <id> [U+E202 <id> ...] U+E201, e.g.
// U+E200 cite U+E202 turn3search1 U+E201. Citations of the CURRENT turn's
// searches are rewritten server-side into markdown links before the text is
// streamed (verified against the codex backend), so we never see those. What
// leaks through verbatim are references to an EARLIER turn's search results -
// their ids are opaque server-side state with no client-resolvable mapping.
// The delimiters render as nothing, so without stripping the user sees the
// inner ASCII ("citeturn3search1...") glued into the sentence. Stripping loses
// nothing: every resolvable citation already arrives as a markdown link.

const CITE_SPAN = /\uE200[^\uE200\uE201]*\uE201/g;
// A marker the stream has started but not finished (streaming tail) - without
// this the payload ASCII flashes visibly until the closing delimiter arrives.
const CITE_TAIL = /\uE200[^\uE200\uE201]*$/;
const CITE_STRAY = /[\uE200-\uE202]/g;

/** Remove OpenAI web-search citation markers (complete, unterminated, or stray). */
export function stripCiteMarkers(text: string): string {
  if (!/[\uE200-\uE202]/.test(text)) return text;
  return text.replace(CITE_SPAN, '').replace(CITE_TAIL, '').replace(CITE_STRAY, '');
}
