import { useEffect } from "react";

export const APP_NAME = "Chat Platform";

// "Feed · Chat Platform" — the one shape every tab, history entry and
// bookmark title takes (issue #498).
export function pageTitle(page: string): string {
  return `${page} · ${APP_NAME}`;
}

// The `head` of a route whose title doesn't depend on data:
// `head: () => staticTitle("Feed")`. HeadContent renders the deepest match's
// title, so this replaces the root's plain "Chat Platform".
export function staticTitle(page: string) {
  return { meta: [{ title: pageTitle(page) }] };
}

// A title derived from data the route loads in its component (a post's
// text, a chat's name, an unread count). Routes fetch through React Query
// rather than loaders, so `head` can't see that data — this overrides the
// route's static `head` title once it's known and leaves that one showing
// until then (`page` undefined).
//
// On cleanup it only restores the previous title if nothing replaced ours in
// the meantime: navigating away commits the next route's `<title>` before
// this cleanup runs, and that must win. Both sides are compared without the
// unread prefix, which `useTabBadge` re-applies to whatever lands.
export function usePageTitle(page: string | undefined) {
  useEffect(() => {
    if (page === undefined) return;
    const previous = stripTitleBadge(document.title);
    const title = pageTitle(page);
    document.title = title;
    return () => {
      if (stripTitleBadge(document.title) === title) document.title = previous;
    };
  }, [page]);
}

// The "(3) " unread prefix `useTabBadge` (lib/tabBadge.ts) puts in front of
// every title, removed — so code comparing titles compares the route's own.
const TITLE_BADGE = /^\(\d+\+?\) /;
export function stripTitleBadge(title: string): string {
  return title.replace(TITLE_BADGE, "");
}

// Trims user-written text (a post body) to something that fits a tab.
export function titleExcerpt(text: string, max = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
