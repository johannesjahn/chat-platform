import { useRouterState } from "@tanstack/react-router";

// Search params shared by /login and /register: where to send the user once
// they're signed in (issue #481). Without it, someone who opened an invite
// link, a post, or a lobby while signed out was dropped on the feed after
// logging in, with the link they came for lost.
export type AuthSearch = { redirect?: string };

export function validateAuthSearch(
  search: Record<string, unknown>,
): AuthSearch {
  // `redirect: undefined` rather than omitting the key: the router merges
  // the raw search params underneath what this returns, so a rejected value
  // left out here would still come back from `useSearch()`.
  return {
    redirect: isSafeRedirect(search.redirect) ? search.redirect : undefined,
  };
}

// Only an in-app path is honored, never an absolute or protocol-relative
// URL (`//evil.example`, `/\evil.example`) — otherwise a crafted login link
// would forward a freshly signed-in user off-site. Pointing back at an auth
// page would just loop, so those are refused too.
function isSafeRedirect(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    !isAuthPath(value)
  );
}

function isAuthPath(href: string): boolean {
  return /^\/(login|register)(?:[/?#]|$)/.test(href);
}

// The page a login/register link should bring the user back to: wherever
// they are now, unless that's the feed (the default anyway) or an auth page
// (so hopping between /login and /register keeps the original target, which
// those pages pass along themselves).
export function useRedirectHere(): string | undefined {
  const href = useRouterState({ select: (state) => state.location.href });
  return href === "/" || isAuthPath(href) ? undefined : href;
}
