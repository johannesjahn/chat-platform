import type { QueryKey } from "@tanstack/react-query";
import { getSession } from "./auth";
import { queryClient } from "./query";

// Route loaders warm the queries a page renders (issue #605), so its
// requests start on link intent — the router's `defaultPreload: "intent"` —
// or at the latest on navigation, instead of after the route's code loaded
// and its component mounted. The view transition then lands on the
// rendered page rather than on skeletons that get swapped out mid-fade.

// How long a navigation may wait on a loader before the page is shown
// anyway, with its skeletons — a slow API never stalls the tap.
export const ROUTE_LOADER_WAIT_MS = 400;

// Runs a route's warm-ups: only when signed in (every page shows a login
// prompt otherwise), with errors left to the component's own queries,
// which show them as before, and the wait capped at `ROUTE_LOADER_WAIT_MS`.
// Pass `ensureQueryData`/`ensureInfiniteQueryData` calls, each wrapped in
// `warmed`, with the same options the component uses, so it reads the
// warmed cache — and data already cached (persisted, or from an earlier
// visit) resolves at once, without a request.
export async function warmRoute(
  warm: () => ReadonlyArray<Promise<unknown>>,
): Promise<void> {
  if (!getSession()) return;
  const done = Promise.all(warm()).catch(() => undefined);
  await Promise.race([
    done,
    new Promise((resolve) => setTimeout(resolve, ROUTE_LOADER_WAIT_MS)),
  ]);
}

// How long data a loader fetched counts as just fetched — the gap between
// hovering a link and following it.
const WARMED_FOR_MS = 10_000;

// The part of a `Query` the checks below read — structural, so it fits any
// query's data and error types.
type WarmableQuery = {
  queryHash: string;
  state: { dataUpdatedAt: number; isInvalidated: boolean };
};

// Query hash -> the `dataUpdatedAt` of the data a loader fetched for it.
const warmedAt = new Map<string, number>();

// Records that `promise` (an `ensure…Data` call for `queryKey`) fetched,
// if it did, so the component mounting next doesn't fetch it all over
// again (see `refetchUnlessWarmed`). Data that was already cached isn't
// recorded: the component refetches that on mount exactly as before.
export function warmed<T>(queryKey: QueryKey, promise: Promise<T>): Promise<T> {
  const since = Date.now();
  return promise.then((data) => {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (query && query.state.dataUpdatedAt >= since)
      warmedAt.set(query.queryHash, query.state.dataUpdatedAt);
    return data;
  });
}

// Whether a query's data is what a loader fetched moments ago, untouched
// since — neither refetched nor invalidated.
export function isFreshlyWarmed(query: WarmableQuery): boolean {
  const at = warmedAt.get(query.queryHash);
  return (
    at !== undefined &&
    at === query.state.dataUpdatedAt &&
    !query.state.isInvalidated &&
    Date.now() - at < WARMED_FOR_MS
  );
}

// `refetchOnMount` for the queries loaders warm: React Query refetches
// stale data on mount, and with the default `staleTime` of 0 that would be
// everything the loader just fetched. Only that mount refetch is skipped
// (or a remount's, within the same few seconds) — focus/reconnect
// refetches, realtime invalidations and later mounts behave as before.
export function refetchUnlessWarmed(query: WarmableQuery): boolean {
  return !isFreshlyWarmed(query);
}
