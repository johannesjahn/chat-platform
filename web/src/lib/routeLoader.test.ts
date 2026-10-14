/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";

// `warmRoute` only runs for a signed-in visitor; outside a browser
// `getSession` is always null, so it's stubbed per test.
let session: object | null = null;
mock.module("./auth", () => ({
  getSession: () => session,
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

  test("it lapses a few seconds after the fetch", async () => {
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
