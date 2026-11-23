# Routes

Route-file code other than `component` ships in the entry chunk; see
"Entry chunk budget" in `web/CLAUDE.md`.

## Route loaders

The feed (`/`), `/chats`, `/chats/$id`, `/posts/$id`, `/notifications` and
`/users/$id` warm the queries they render in a `loader` (issue #605), so
with `defaultPreload: "intent"` requests start on hover/touch. Helpers are in
`web/src/lib/routeLoader.ts`. A loader that skips one of these rules brings
back double fetches or broken paging:

- **One options builder, shared**: loader and component build their query
  from the same function (`postsFeedQueryOptions()`,
  `chatDetailQueryOptions(id)`, `notificationsListQueryOptions(…)`, …), so
  the component reads the entry the loader warmed.
- **`warmRoute` + `warmed`**: a loader body is `warmRoute(() => [...])`
  (skips signed-out visitors, waits at most `ROUTE_LOADER_WAIT_MS`, swallows
  errors for the page's own queries). Each `ensureQueryData` /
  `ensureInfiniteQueryData` in it is wrapped in `warmed(queryKey, …)`, which
  records that the loader actually fetched.
- **`refetchOnMount: refetchUnlessWarmed`** on the component's query (set
  in the options builder); `warmed` and `refetchUnlessWarmed` come as a
  pair. The mark is one-time (issue #615): only the first subscribing
  mount's refetch is skipped, and an unread mark lapses after 10s.
- **State outside the cache needs more**: `useChatMessages` keeps paging
  cursors in refs, so the cached window also stores
  `earliestCursor`/`latestCursor`, and a mount that finds a freshly warmed
  window (`isFreshlyWarmed`) adopts them (`warmChatMessages` in
  `web/src/lib/chats.ts`). Any other hook with such state does the same.
- The socket's first connect refetches every event-driven query anyway
  (the reconnect self-heal), which is why loader tests measure client-side
  navigations, not full page loads.

Tests: freshness rules in `web/src/lib/routeLoader.test.ts`; end-to-end in
`web/e2e/route-loaders.spec.ts`: start from `openSettled`, hover the link
first, then count the requests the navigation sends.

## `/chats` layout route

`chats/route.tsx` is a layout: at `lg`+ the chat list sits in a resizable
left pane with every `/chats/*` page on the right; below `lg` it's a
pass-through. See `web/src/components/chat/CLAUDE.md`.
