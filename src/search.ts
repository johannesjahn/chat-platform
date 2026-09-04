import type { SearchSnippetSegment } from "./Api.ts";

// ---------------------------------------------------------------------------
// Search query analysis + snippet building
//
// Everything in this module is pure string work — no SQL, no I/O — so the
// matching rules and the highlighting can be unit-tested directly (see
// search.test.ts) and reused by every search endpoint in SearchHandler.ts.
//
// A row matches a query when *either* of two independent, index-served
// branches hits (see `matchBranches` in SearchHandler.ts — and `matchingIds`
// beside it for why they're run as a union rather than an `OR`):
//
//   1. **Word/prefix branch** — the row's generated `tsvector` matches a
//      `to_tsquery` built from the query's tokens, each suffixed with `:*`
//      (`fox & jump:*` style). This is the one that understands language:
//      "run" finds "running" via the english stemmer, and the trailing `:*`
//      makes a half-typed last word ("jum") match while the user is still
//      typing. Served by the GIN index over `search_vector` (migration 0017).
//
//   2. **Substring branch** — every token appears somewhere in the raw text,
//      anywhere inside a word (`ILIKE '%frag%'`). This is what makes searching
//      for a *fragment* work at all: `to_tsvector` only ever indexes whole
//      (stemmed) lexemes, so "ragmen" can never match "fragmentary" through
//      branch 1. Served by the GIN trigram indexes added in migration 0023, so
//      it stays an index lookup rather than the sequential scan an unanchored
//      ILIKE would otherwise force.
//
// Trigram indexes can only serve a pattern that contains at least one full
// trigram, so the substring branch is only used once a token is at least
// `MIN_SUBSTRING_TOKEN_LENGTH` characters — shorter queries fall back to the
// prefix branch alone, which is index-served at any length.
// ---------------------------------------------------------------------------

// Postgres text-search configuration used for every indexed `tsvector` (see
// migration 0017) and every query. Must match the config baked into the
// generated columns, or the query lexemes wouldn't line up with the indexed
// ones — "english" applies stemming and stop-word removal on both sides.
export const SEARCH_CONFIG = "english";

// Shortest token we'll hand to a trigram-indexed `ILIKE '%…%'`. A GIN
// `gin_trgm_ops` index can only answer a pattern holding at least one complete
// trigram, so a 1-2 character fragment would degrade into a sequential scan
// over the whole table — exactly what these indexes exist to avoid. Such a
// query is still answered, just by the prefix branch alone.
export const MIN_SUBSTRING_TOKEN_LENGTH = 3;

// Guards a pathological query ("a b c d e …"): each token adds one AND'd
// clause to both branches, so the query text is bounded (MAX_SEARCH_QUERY_LENGTH)
// *and* the token count is, keeping the planner's work fixed no matter what a
// client sends.
export const MAX_SEARCH_TOKENS = 8;

// Splits a raw query into the lexical tokens both branches are built from:
// runs of letters/digits (Unicode-aware, so "café" and "日本語" tokenize), with
// everything else — punctuation, quotes, tsquery operators like `&`/`|`/`!`,
// SQL syntax — dropped. That dropping is what makes `to_tsquery` (which
// *does* raise on malformed input, unlike `websearch_to_tsquery`) safe to use:
// a token can never carry an operator, so the assembled tsquery is always
// syntactically valid. The query text itself is still passed to Postgres as a
// bound parameter, never interpolated.
export const searchTokens = (q: string): string[] => {
  const tokens = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.slice(0, MAX_SEARCH_TOKENS);
};

// Assembles the prefix `tsquery` text for branch 1: every token AND'd, each
// allowed to match as a prefix. Returns null when the query holds no tokens at
// all (e.g. "!!!"), which the caller turns into "this branch matches nothing"
// — `to_tsquery('')` would otherwise raise a syntax error.
//
// Note the `:*` is applied to *every* token, not just the last: it costs
// nothing extra on the GIN index and makes multi-word as-you-type queries
// ("qui bro fo") behave the way users expect. Stop words ("the") and stemming
// are still applied by `to_tsquery` itself, so this stays language-aware.
export const toPrefixTsQuery = (q: string): string | null => {
  const tokens = searchTokens(q);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}:*`).join(" & ");
};

// The tokens branch 2 is built from: every token of the query (so the match
// stays as precise as branch 1 — all tokens must appear), used only when at
// least one of them is long enough for the trigram index to drive the scan.
// Returns an empty array when no token qualifies, which disables the branch.
export const substringTokens = (q: string): string[] => {
  const tokens = searchTokens(q);
  if (!tokens.some((t) => t.length >= MIN_SUBSTRING_TOKEN_LENGTH)) return [];
  return tokens;
};

// Escapes LIKE/ILIKE wildcard characters in user-supplied search text so a
// query containing "%" or "_" is matched literally instead of as a wildcard.
// Shared with UsersHandler.ts's `searchUsers`.
export const escapeLikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, (char) => `\\${char}`);

// The `ILIKE` pattern for a "contains this fragment anywhere" match.
export const containsPattern = (value: string): string =>
  `%${escapeLikePattern(value)}%`;

// The `ILIKE` pattern for a "starts with" match — used to rank people results
// (a prefix hit on a username beats a hit in the middle of it).
export const startsWithPattern = (value: string): string =>
  `${escapeLikePattern(value)}%`;

// ---------------------------------------------------------------------------
// Snippets
//
// Highlighting is done here, in TypeScript, rather than with Postgres'
// `ts_headline`. Two reasons:
//
//   * `ts_headline` re-parses the whole document per result row — the single
//     most expensive part of the old search — and it can only highlight what
//     the *tsquery* matched, so a pure substring hit ("ragmen" inside
//     "fragmentary") would come back with nothing marked at all.
//   * Doing it in-process is a linear scan of an already-fetched string, and
//     it highlights exactly what the user typed, for both match branches.
//
// The output is a list of runs, each flagged `match` or not — never HTML — so
// the frontend renders every run as escaped text (see SearchHighlight.tsx) and
// user content containing markup can never become markup.
// ---------------------------------------------------------------------------

// Longest snippet we build, in characters. Long enough to give a matched
// fragment real context, short enough that a page of results stays small on
// the wire.
export const SNIPPET_MAX_LENGTH = 180;

// How much text to keep *before* the first match, so a hit in the middle of a
// long document doesn't render flush against the leading ellipsis.
const SNIPPET_LEAD = 48;

// Bounds the highlight work on a pathological document (a 10k-character post
// of the same word): only the first `MAX_HIGHLIGHTS` occurrences are located,
// which is far more than fit in `SNIPPET_MAX_LENGTH` anyway.
const MAX_HIGHLIGHTS = 64;

const ELLIPSIS = "…";

// Word-ish characters used to snap a window edge outward to a boundary, so a
// snippet starts/ends on a whole word instead of mid-token when possible.
const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}]/u.test(char);

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Range = { start: number; end: number };

// Every case-insensitive occurrence of `needle` in `haystack`. Uses a regex
// (rather than lower-casing both sides and using indexOf) because
// `toLowerCase` can change a string's *length* for some Unicode characters,
// which would misalign every index against the original text.
const occurrences = (haystack: string, needle: string): Range[] => {
  const ranges: Range[] = [];
  if (needle.length === 0) return ranges;
  const re = new RegExp(escapeRegExp(needle), "giu");
  let match: RegExpExecArray | null;
  while ((match = re.exec(haystack)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
    if (ranges.length >= MAX_HIGHLIGHTS) break;
    // Guard against a zero-length match looping forever.
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return ranges;
};

// All the spans of `content` worth highlighting for `q`: the full query phrase
// (so "quick brown" highlights as one run when it appears verbatim) plus each
// individual token, merged into a sorted, non-overlapping list.
export const highlightRanges = (content: string, q: string): Range[] => {
  const needles = [q.trim(), ...searchTokens(q)].filter((n) => n.length > 0);
  const found = needles.flatMap((n) => occurrences(content, n));
  if (found.length === 0) return [];
  found.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: Range[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
};

// Moves a window edge outward to the nearest word boundary (at most `slack`
// characters), so snippets don't start or end mid-word. Also never splits a
// surrogate pair.
const snapStart = (content: string, index: number, slack = 12): number => {
  let i = index;
  const floor = Math.max(0, index - slack);
  while (i > floor && isWordChar(content[i - 1])) i--;
  // A lone low surrogate would render as a replacement character.
  if (i > 0 && /[\uDC00-\uDFFF]/.test(content[i] ?? "")) i--;
  return i;
};

const snapEnd = (content: string, index: number, slack = 12): number => {
  let i = Math.min(index, content.length);
  const ceil = Math.min(content.length, index + slack);
  while (i < ceil && isWordChar(content[i])) i++;
  if (i < content.length && /[\uDC00-\uDFFF]/.test(content[i] ?? "")) i++;
  return i;
};

const push = (
  segments: SearchSnippetSegment[],
  text: string,
  match: boolean,
): void => {
  if (text.length > 0) segments.push({ text, match });
};

// Builds the highlighted excerpt for one result row.
//
// When the query text is literally present, the window is centered on the
// first occurrence and every occurrence inside it is marked. When it isn't —
// the row matched only through stemming, e.g. "run" finding "running" in a
// form the raw text doesn't contain — the excerpt is simply the head of the
// content with nothing marked, which is still the right thing to show.
export const buildSnippet = (
  content: string,
  q: string,
): SearchSnippetSegment[] => {
  const ranges = highlightRanges(content, q);
  const segments: SearchSnippetSegment[] = [];

  const first = ranges[0];
  let start = first
    ? snapStart(content, Math.max(0, first.start - SNIPPET_LEAD))
    : 0;
  if (first && first.start - start > SNIPPET_LEAD) start = first.start;
  let end = snapEnd(
    content,
    Math.min(content.length, start + SNIPPET_MAX_LENGTH),
  );
  // Never cut the first match itself in half — if it's longer than the whole
  // window, the window grows to hold it.
  if (first && end < first.end) end = Math.min(content.length, first.end);

  if (start > 0) push(segments, ELLIPSIS, false);

  let cursor = start;
  for (const range of ranges) {
    if (range.end <= start) continue;
    if (range.start >= end) break;
    const matchStart = Math.max(range.start, start);
    const matchEnd = Math.min(range.end, end);
    push(segments, content.slice(cursor, matchStart), false);
    push(segments, content.slice(matchStart, matchEnd), true);
    cursor = matchEnd;
  }
  push(segments, content.slice(cursor, end), false);

  if (end < content.length) push(segments, ELLIPSIS, false);
  return segments;
};

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

// Opaque keyset cursor over the content searches' sort (`id desc`) — identical
// scheme to `listPosts` (see PostsHandler.ts): the last row's id, base64url-
// encoded, so the next page resumes at "the next `limit` matches with a
// smaller id" with no OFFSET to scan past. Never constructed by clients, only
// round-tripped from a previous page's `nextCursor`.
export const encodeSearchCursor = (id: number): string =>
  Buffer.from(String(id)).toString("base64url");

export const decodeSearchCursor = (cursor: string): number | null => {
  const id = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isInteger(id) ? id : null;
};

// People results aren't ordered by recency but by how well the row matches
// (exact username, then prefix, then anywhere) and then alphabetically, so
// their cursor has to carry the whole sort tuple rather than just an id — see
// `searchUsers` in SearchHandler.ts, which resumes with a row-value comparison
// on exactly these three columns. Encoded as one opaque base64url blob so it
// stays as unparseable to a client as the id cursor above.
export type UserSearchCursor = { rank: number; username: string; id: number };

export const encodeUserSearchCursor = (cursor: UserSearchCursor): string =>
  Buffer.from(
    JSON.stringify([cursor.rank, cursor.username, cursor.id]),
  ).toString("base64url");

export const decodeUserSearchCursor = (
  cursor: string,
): UserSearchCursor | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [rank, username, id] = parsed;
  if (!Number.isInteger(rank) || !Number.isInteger(id)) return null;
  if (typeof username !== "string") return null;
  return { rank, username, id };
};
