// Human-friendly time formatting for feed posts and comments. Chat messages
// keep their own exact-time formatting (see `formatChatTimestamp` in chats.ts)
// — the WhatsApp/Telegram convention — so this module deliberately covers the
// "social feed" surfaces where a compact relative age ("3m", "2h", "5d") reads
// better than an absolute wall-clock stamp.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Compact relative age. Anything a week or older falls back to an absolute
// short date so the label never grows unbounded ("83d" is less scannable than
// the actual date). `now` is injectable so callers with a shared clock tick
// (see RelativeTime) stay consistent and testable.
export function formatRelativeTime(
  ms: number,
  now: number = Date.now(),
): string {
  const diff = now - ms;

  // Guard against clock skew where a server timestamp is slightly ahead of the
  // client — treat a small future delta as "just now" rather than "-1s".
  if (diff < 30_000) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d`;

  return formatShortDate(ms);
}

// "Jul 26" for the current year, "Jul 26, 2024" otherwise.
function formatShortDate(ms: number): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

// Full, unambiguous timestamp for the `title`/tooltip so hovering a relative
// label always reveals the exact time.
export function formatAbsoluteTime(ms: number): string {
  return new Date(ms).toLocaleString();
}
