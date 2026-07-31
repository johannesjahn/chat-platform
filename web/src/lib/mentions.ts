import { useMemo } from "react";
import { $api } from "./api";
import type { components } from "./api-types";
import { useSession } from "./auth";

// `@username` mentions in post/comment/message content (issue #318).
//
// The token character class is deliberately narrower than what the backend
// accepts as a username (any non-empty trimmed string up to
// `MAX_USERNAME_LENGTH` characters — see `Username` in src/Api.ts): a
// mention sits inside ordinary prose and has to end *somewhere*, so only
// characters that can't be mistaken for the punctuation around it are part
// of the token. A user whose username falls outside this class simply
// isn't reachable by typing `@` — which is why `isMentionable` below also
// filters the composer's autocomplete, rather than offering a suggestion
// that couldn't be written down.
// "-" is last so it reads as a literal inside the character classes below
// rather than opening a range.
const MENTION_CHARS = "A-Za-z0-9_.-";

// Mirrors `MAX_USERNAME_LENGTH` in src/Api.ts — bounds the token so a long
// run of mention-class characters can't be scanned as one giant "username".
const MAX_USERNAME_LENGTH = 32;

// Mirrors `MAX_USERNAME_LOOKUP_COUNT` in src/Api.ts. Content naming more
// distinct users than this has the rest rendered as plain text rather than
// the whole lookup being rejected.
export const MAX_USERNAME_LOOKUP_COUNT = 32;

// The `@` must not itself be preceded by a mention character, so an email
// address ("someone@example.com") or a mid-word "@" never starts a mention.
const MENTION_RE = new RegExp(
  `(?<![${MENTION_CHARS}])@([${MENTION_CHARS}]{1,${MAX_USERNAME_LENGTH}})`,
  "g",
);

// Same shape, anchored to the end of a string — used against the text
// before the caret to find the mention currently being typed.
const ACTIVE_MENTION_RE = new RegExp(
  `(?<![${MENTION_CHARS}])@([${MENTION_CHARS}]{0,${MAX_USERNAME_LENGTH}})$`,
);

// A username may legitimately contain "." or "-", but a mention that ends
// in one is almost always prose punctuation that got swept in ("ask
// @alice.", "@bob-"). Trailing runs of them are handed back to the
// surrounding text; anything left is the username.
function trimTrailingPunctuation(username: string): string {
  return username.replace(/[.-]+$/, "");
}

// Whether `username` can be written as an `@mention` at all — i.e. whether
// it survives the parse above unchanged. Used to filter autocomplete
// suggestions (see MentionTextarea).
export function isMentionable(username: string): boolean {
  const matches = [...`@${username}`.matchAll(MENTION_RE)];
  return (
    matches.length === 1 &&
    trimTrailingPunctuation(matches[0]![1]!) === username
  );
}

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; text: string; username: string };

// Splits `text` into alternating plain-text and mention runs. Every
// segment's `text` is a verbatim slice of the input, so concatenating them
// reproduces the original exactly — the renderer never has to reconstruct
// the source, and a mention that doesn't resolve to a real account can be
// dropped back to plain text with no loss.
export function parseMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(MENTION_RE)) {
    const username = trimTrailingPunctuation(match[1]!);
    if (username.length === 0) continue;
    const start = match.index;
    const end = start + 1 + username.length;
    if (start > cursor)
      segments.push({ type: "text", text: text.slice(cursor, start) });
    segments.push({ type: "mention", text: text.slice(start, end), username });
    cursor = end;
  }

  if (cursor < text.length)
    segments.push({ type: "text", text: text.slice(cursor) });
  return segments;
}

// The distinct usernames `text` mentions, lowercased (usernames are unique
// case-insensitively — see issue #175) and sorted so the same set of
// mentions always produces the same lookup key no matter what order they
// appear in, letting React Query share one request across every piece of
// content that names the same people.
export function mentionedUsernames(text: string): string[] {
  const names = new Set<string>();
  for (const segment of parseMentions(text))
    if (segment.type === "mention") names.add(segment.username.toLowerCase());
  return [...names].sort().slice(0, MAX_USERNAME_LOOKUP_COUNT);
}

export type MentionedUser = components["schemas"]["User"];

// Resolves the `@mentions` in `text` to real accounts, keyed by lowercased
// username. Content with no mentions issues no request at all; names with
// no account are absent from the map and render as plain text.
export function useMentionedUsers(text: string): Map<string, MentionedUser> {
  const usernames = useMemo(() => mentionedUsernames(text), [text]);
  // The lookup is authenticated, so a signed-out viewer skips it entirely
  // rather than firing a request that can only 401 — their mentions stay
  // plain text (as does the profile those links would point at).
  const session = useSession();
  const { data } = $api.useQuery(
    "get",
    "/users/by-username",
    { params: { query: { usernames: usernames.join(",") } } },
    {
      enabled: session !== null && usernames.length > 0,
      // Who owns a username effectively never changes, so a resolved
      // mention doesn't need refetching while the feed is open.
      staleTime: 5 * 60 * 1000,
    },
  );

  return useMemo(() => {
    const byUsername = new Map<string, MentionedUser>();
    for (const user of data ?? [])
      byUsername.set(user.username.toLowerCase(), user);
    return byUsername;
  }, [data]);
}

// The mention being typed immediately before `caret`, or null when the
// caret isn't inside one. `start`/`end` bound the `@…` token itself so a
// picked suggestion can replace exactly that slice.
export type ActiveMention = { query: string; start: number; end: number };

export function activeMentionAt(
  text: string,
  caret: number,
): ActiveMention | null {
  const match = ACTIVE_MENTION_RE.exec(text.slice(0, caret));
  if (!match) return null;
  return { query: match[1]!, start: match.index, end: caret };
}

// Replaces the `@…` token at `mention` with the completed `@username`,
// returning the new text and where the caret should land — always just past
// a single separating space, so the user can keep typing straight away.
// Completing a mention mid-sentence reuses the space that's already there
// rather than doubling it.
export function applyMention(
  text: string,
  mention: ActiveMention,
  username: string,
): { text: string; caret: number } {
  const followedBySpace = text[mention.end] === " ";
  const inserted = followedBySpace ? `@${username}` : `@${username} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(mention.end),
    caret: mention.start + inserted.length + (followedBySpace ? 1 : 0),
  };
}
