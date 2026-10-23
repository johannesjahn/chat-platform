/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";

// `warmRoute` only runs for a signed-in visitor; outside a browser
// `getSession` is always null, so it's stubbed per test. Bun's module mocks
// are shared by every file in a run, so the stub also covers what api.ts
// imports from ./auth (see api.test.ts).
let session: object | null = null;
mock.module("./auth", () => ({
  getSession: () => session,
  setSession: () => {},
  clearSession: () => {},
  subscribeSession: () => () => {},
}));

const { queryClient } = await import("./query");
const {
  ROUTE_LOADER_WAIT_MS,
  isFreshlyWarmed,
  refetchUnlessWarmed,
  warmRoute,
  warmed,
} = await import("./routeLoader");

let realNow: () => number;
let now: number;

beforeEach(() => {
  queryClient.clear();
  session = null;
  realNow = Date.now;
  now = realNow();
  Date.now = () => now;
});

afterEach(() => {
  Date.now = realNow;
});

function find(queryKey: readonly unknown[]) {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (!query) throw new Error(`no query for ${JSON.stringify(queryKey)}`);
  return query;
}

// What a loader does: ensure the data, recorded through `warmed`.
function warm(queryKey: readonly unknown[], queryFn = async () => "data") {
  return warmed(queryKey, queryClient.ensureQueryData({ queryKey, queryFn }));
}

describe("warmed / isFreshlyWarmed", () => {
  test("data a loader fetched counts as freshly warmed", async () => {
    await warm(["fetched"]);
    expect(isFreshlyWarmed(find(["fetched"]))).toBe(true);
    expect(refetchUnlessWarmed(find(["fetched"]))).toBe(false);
  });

  test("data that was already cached isn't marked, so mounts still refetch it", async () => {
    queryClient.setQueryData(["cached"], "persisted");
    now += 1;
    const queryFn = mock(async () => "fresh");
    expect(await warm(["cached"], queryFn)).toBe("persisted");
    expect(queryFn).not.toHaveBeenCalled();
    expect(refetchUnlessWarmed(find(["cached"]))).toBe(true);
  });

  test("a refetch since the loader's fetch ends it", async () => {
    await warm(["refetched"]);
    now += 1;
    queryClient.setQueryData(["refetched"], "newer");
    expect(refetchUnlessWarmed(find(["refetched"]))).toBe(true);
  });

  test("an invalidation ends it", async () => {
    await warm(["invalidated"]);
    await queryClient.invalidateQueries({
      queryKey: ["invalidated"],
      refetchType: "none",
    });
    expect(refetchUnlessWarmed(find(["invalidated"]))).toBe(true);
  });

  test("unread, it lapses a few seconds after the fetch", async () => {
    await warm(["lapsing"]);
    now += 9_999;
    expect(isFreshlyWarmed(find(["lapsing"]))).toBe(true);
    now += 1;
    expect(isFreshlyWarmed(find(["lapsing"]))).toBe(false);
  });

  test("a failed fetch isn't recorded, and the error reaches the caller", async () => {
    const failing = warm(["failing"], async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    expect(refetchUnlessWarmed(find(["failing"]))).toBe(true);
  });
});

describe("refetchUnlessWarmed as refetchOnMount", () => {
  // Mounts an observer the way `useQuery` does and reports whether that
  // mount sent a request.
  async function mountFetches(queryKey: readonly unknown[]) {
    const queryFn = mock(async () => "remounted");
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn,
      refetchOnMount: refetchUnlessWarmed,
    });
    const unsubscribe = observer.subscribe(() => {});
    await Promise.resolve();
    unsubscribe();
    return queryFn.mock.calls.length > 0;
  }

  test("the component's mount doesn't fetch what its loader just fetched", async () => {
    await warm(["mount-warmed"]);
    expect(await mountFetches(["mount-warmed"])).toBe(false);
  });

  test("a later mount refetches as before", async () => {
    await warm(["mount-twice"]);
    expect(await mountFetches(["mount-twice"])).toBe(false);
    expect(isFreshlyWarmed(find(["mount-twice"]))).toBe(false);
    expect(await mountFetches(["mount-twice"])).toBe(true);
  });

  test("every check of the first mount agrees, before and while it subscribes", async () => {
    await warm(["mount-checks"]);
    const queryFn = mock(async () => "remounted");
    const observer = new QueryObserver(queryClient, {
      queryKey: ["mount-checks"],
      queryFn,
      refetchOnMount: refetchUnlessWarmed,
    });
    // The optimistic render, and a render-time check like
    // `useChatMessages`'s cursor adoption, both read it before subscribing.
    expect(
      observer.getOptimisticResult({
        ...queryClient.defaultQueryOptions(observer.options),
        _optimisticResults: "optimistic",
      }).isFetching,
    ).toBe(false);
    expect(isFreshlyWarmed(find(["mount-checks"]))).toBe(true);
    const unsubscribe = observer.subscribe(() => {});
    await Promise.resolve();
    unsubscribe();
    expect(queryFn).not.toHaveBeenCalled();
    expect(isFreshlyWarmed(find(["mount-checks"]))).toBe(false);
  });

  test("observers subscribing in the same commit all skip the refetch", async () => {
    await warm(["mount-together"]);
    const queryFn = mock(async () => "remounted");
    const observers = [1, 2].map(
      () =>
        new QueryObserver(queryClient, {
          queryKey: ["mount-together"],
          queryFn,
          refetchOnMount: refetchUnlessWarmed,
        }),
    );
    const unsubscribes = observers.map((o) => o.subscribe(() => {}));
    await Promise.resolve();
    unsubscribes.forEach((unsubscribe) => unsubscribe());
    expect(queryFn).not.toHaveBeenCalled();
  });

  test("a new loader fetch marks it again for the next mount", async () => {
    await warm(["mount-rewarmed"]);
    expect(await mountFetches(["mount-rewarmed"])).toBe(false);
    queryClient.removeQueries({ queryKey: ["mount-rewarmed"] });
    now += 1;
    await warm(["mount-rewarmed"]);
    expect(await mountFetches(["mount-rewarmed"])).toBe(false);
  });

  test("cached-but-stale data is refetched on mount as before", async () => {
    queryClient.setQueryData(["mount-cached"], "persisted");
    now += 1;
    await warm(["mount-cached"]);
    expect(await mountFetches(["mount-cached"])).toBe(true);
  });
});

describe("warmRoute", () => {
  test("does nothing while signed out", async () => {
    const warmUps = mock(() => [Promise.resolve()]);
    await warmRoute(warmUps);
    expect(warmUps).not.toHaveBeenCalled();
  });

  test("waits for the warm-ups when they're quick", async () => {
    session = {};
    let done = false;
    await warmRoute(() => [
      new Promise<void>((resolve) =>
        setTimeout(() => {
          done = true;
          resolve();
        }, 10),
      ),
    ]);
    expect(done).toBe(true);
  });

  test("gives up waiting after ROUTE_LOADER_WAIT_MS", async () => {
    session = {};
    const started = realNow();
    await warmRoute(() => [new Promise(() => {})]);
    const waited = realNow() - started;
    expect(waited).toBeGreaterThanOrEqual(ROUTE_LOADER_WAIT_MS - 20);
    expect(waited).toBeLessThan(ROUTE_LOADER_WAIT_MS + 500);
  });

  test("leaves errors to the page instead of failing the navigation", async () => {
    session = {};
    await expect(
      warmRoute(() => [Promise.reject(new Error("api down"))]),
    ).resolves.toBeUndefined();
  });
});
