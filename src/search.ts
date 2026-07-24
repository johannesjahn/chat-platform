import type { SearchSnippetSegment } from "./Api.ts";

// Postgres text-search configuration used for every indexed `tsvector` (see
// migration 0016) and every query. Must match the config baked into the
// generated columns, or the query lexemes wouldn't line up with the indexed
// ones — "english" applies stemming and stop-word removal on both sides.
export const SEARCH_CONFIG = "english";

// Delimiters `ts_headline` wraps matched lexemes in. Two Unicode Private Use
// Area code points: they carry no meaning of their own and effectively never
// occur in real user text, so they're safe to split on without colliding with
// content — and even if a user did paste one, the worst case is a cosmetic
// mis-highlight, never an injection (the frontend renders every run as escaped
// text, see `SearchSnippetSegment`). Chosen over `<mark>`/`</mark>` precisely
// so the snippet can never be mistaken for HTML anywhere in the pipeline.
const HL_START = "";
const HL_STOP = "";

// `ts_headline` options string. HighlightAll=false keeps it to a windowed
// fragment (not the whole document) so a hit inside a long post/message
// returns a readable excerpt rather than the entire body; MaxFragments>1 lets
// it stitch together a couple of windows when matches are far apart.
export const TS_HEADLINE_OPTIONS =
  `StartSel=${HL_START},StopSel=${HL_STOP},` +
  "MaxWords=24,MinWords=8,ShortWord=2,MaxFragments=2,FragmentDelimiter= … ,HighlightAll=false";

// Splits `ts_headline` output on the sentinel delimiters into ordered runs,
// each flagged whether it was a highlighted match. Empty runs (adjacent
// delimiters, or leading/trailing) are dropped so the frontend never renders a
// stray empty `<mark>`. Tolerant of a stray/unpaired sentinel: a start with no
// stop just runs to the end of the string.
export const parseSnippet = (raw: string): SearchSnippetSegment[] => {
  const segments: SearchSnippetSegment[] = [];
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf(HL_START, i);
    if (start === -1) {
      if (i < raw.length) segments.push({ text: raw.slice(i), match: false });
      break;
    }
    if (start > i) segments.push({ text: raw.slice(i, start), match: false });
    const stop = raw.indexOf(HL_STOP, start + 1);
    if (stop === -1) {
      segments.push({ text: raw.slice(start + 1), match: true });
      break;
    }
    if (stop > start + 1)
      segments.push({ text: raw.slice(start + 1, stop), match: true });
    i = stop + 1;
  }
  return segments.filter((s) => s.text.length > 0);
};

// Opaque keyset cursor over the search sort (`id desc`) — identical scheme to
// `listPosts` (see PostsHandler.ts): the last row's id, base64url-encoded, so
// the next page resumes at "the next `limit` matches with a smaller id" with no
// OFFSET to scan past. Never constructed by clients, only round-tripped from a
// previous page's `nextCursor`.
export const encodeSearchCursor = (id: number): string =>
  Buffer.from(String(id)).toString("base64url");

export const decodeSearchCursor = (cursor: string): number | null => {
  const id = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isInteger(id) ? id : null;
};
