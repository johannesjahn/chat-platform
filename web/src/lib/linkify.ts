// Auto-links bare `http(s)` URLs in post/comment/message content (issue
// #319) — deliberately linkify-only, no unfurl/embed.

const URL_RE = /https?:\/\/[^\s<>"']+/g;

const TRAILING_PUNCTUATION_CHARS = ".,!?;:'\"";

// A URL scraped out of prose almost always drags trailing punctuation along
// with it ("see https://example.com." or "(https://example.com)") — strip it
// back off, the same way `trimTrailingPunctuation` in mentions.ts trims a
// mention. A trailing ")" is only trimmed when the URL doesn't already
// contain a matching "(", so links with balanced parens in the path (e.g.
// Wikipedia article titles) survive intact.
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (TRAILING_PUNCTUATION_CHARS.includes(ch)) {
      end--;
      continue;
    }
    if (ch === ")") {
      const prefix = url.slice(0, end - 1);
      const opens = (prefix.match(/\(/g) ?? []).length;
      const closes = (prefix.match(/\)/g) ?? []).length;
      if (opens > closes) break;
      end--;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

export type LinkSegment =
  { type: "text"; text: string } | { type: "link"; text: string; url: string };

// Splits `text` into alternating plain-text and URL runs, mirroring
// `parseMentions`'s contract: every segment's `text` is a verbatim slice of
// the input, so concatenating them reproduces the original exactly.
export function parseLinks(text: string): LinkSegment[] {
  const segments: LinkSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_RE)) {
    const url = trimTrailingPunctuation(match[0]);
    if (url.length === 0) continue;
    const start = match.index;
    const end = start + url.length;
    if (start > cursor)
      segments.push({ type: "text", text: text.slice(cursor, start) });
    segments.push({ type: "link", text: text.slice(start, end), url });
    cursor = end;
  }

  if (cursor < text.length)
    segments.push({ type: "text", text: text.slice(cursor) });
  return segments;
}
