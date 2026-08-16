// "3m", "2h", "Tue" — the age of a chat row, in as few characters as will do.
//
// Pure and taking `now` as an argument, which is the only way a time formatter
// can be tested at all. Unix SECONDS in, because that is what ChatSummary
// carries (see src/shared/types.ts) and converting at the call site is how one
// screen ends up dividing by 1000 twice.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function relativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  const seconds = Math.floor(nowMs / 1000) - Math.floor(unixSeconds);
  // A clock that disagrees with the server's by a few seconds is ordinary; "in
  // 4s" is not something to render, so anything in the future reads as now.
  if (seconds < MINUTE) return 'now';
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h`;
  if (seconds < 7 * DAY) return WEEKDAYS[new Date(unixSeconds * 1000).getDay()];
  const date = new Date(unixSeconds * 1000);
  return `${date.getDate()}/${date.getMonth() + 1}`;
}
