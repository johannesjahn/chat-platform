/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { type Connectivity, loadWhenOnline, RETRY_DELAY_MS } from "./lazy";

// A switchable stand-in for the app's connectivity signal.
function fakeNetwork(online: boolean) {
  let waiters: (() => void)[] = [];
  const connectivity: Connectivity = {
    isOnline: () => online,
    whenOnline: () =>
      online ? Promise.resolve() : new Promise((r) => waiters.push(r)),
  };
  return {
    connectivity,
    goOnline: () => {
      online = true;
      const fire = waiters;
      waiters = [];
      for (const resolve of fire) resolve();
    },
    goOffline: () => {
      online = false;
    },
    waiting: () => waiters.length,
  };
}

// Records the pauses `loadWhenOnline` takes, running `during` inside each
// (e.g. to let the browser notice it went offline meanwhile).
function fakeDelay(during: () => void = () => {}) {
  const pauses: number[] = [];
  const delay = async (ms: number) => {
    pauses.push(ms);
    during();
  };
  return { delay, pauses };
}

// Lets pending promise callbacks run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const fetchError = () =>
  new TypeError("Failed to fetch dynamically imported module");

describe("loadWhenOnline", () => {
  test("resolves with the first successful load", async () => {
    const net = fakeNetwork(true);
    const { delay, pauses } = fakeDelay();
    let calls = 0;
    const result = await loadWhenOnline(
      async () => {
        calls++;
        return "module";
      },
      { connectivity: net.connectivity, delay },
    );
    expect(result).toBe("module");
    expect(calls).toBe(1);
    expect(pauses).toEqual([]);
  });

  test("retries a load that failed online once, after a pause", async () => {
    const net = fakeNetwork(true);
    const { delay, pauses } = fakeDelay();
    let calls = 0;
    const result = await loadWhenOnline(
      async () => {
        if (++calls === 1) throw fetchError();
        return "module";
      },
      { connectivity: net.connectivity, delay },
    );
    expect(result).toBe("module");
    expect(calls).toBe(2);
    expect(pauses).toEqual([RETRY_DELAY_MS]);
  });

  test("rejects after a second failure while online", async () => {
    const net = fakeNetwork(true);
    const { delay } = fakeDelay();
    let calls = 0;
    await expect(
      loadWhenOnline(
        async () => {
          throw new TypeError(`attempt ${++calls}`);
        },
        { connectivity: net.connectivity, delay },
      ),
    ).rejects.toThrow("attempt 2");
    expect(calls).toBe(2);
  });

  test("waits for the connection to come back, then retries", async () => {
    const net = fakeNetwork(true);
    const { delay, pauses } = fakeDelay();
    let calls = 0;
    const result = loadWhenOnline(
      async () => {
        if (++calls === 1) {
          // The connection drops while the chunk is downloading.
          net.goOffline();
          throw fetchError();
        }
        return "module";
      },
      { connectivity: net.connectivity, delay },
    );

    await flush();
    expect(calls).toBe(1);
    expect(net.waiting()).toBe(1);
    expect(pauses).toEqual([]);

    net.goOnline();
    expect(await result).toBe("module");
    expect(calls).toBe(2);
  });

  test("waits for the connection when the offline signal lags the failure", async () => {
    const net = fakeNetwork(true);
    // The request fails first; the browser only reports the drop during
    // the pause that follows.
    const { delay } = fakeDelay(() => net.goOffline());
    let calls = 0;
    const result = loadWhenOnline(
      async () => {
        if (++calls === 1) throw fetchError();
        return "module";
      },
      { connectivity: net.connectivity, delay },
    );

    await flush();
    expect(calls).toBe(1);
    expect(net.waiting()).toBe(1);

    net.goOnline();
    expect(await result).toBe("module");
    expect(calls).toBe(2);
  });

  test("keeps waiting while retries keep failing offline", async () => {
    const net = fakeNetwork(false);
    const { delay } = fakeDelay();
    let calls = 0;
    const result = loadWhenOnline(
      async () => {
        if (++calls < 3) {
          // Back online, but it drops again before the retry gets through.
          net.goOffline();
          throw fetchError();
        }
        return "module";
      },
      { connectivity: net.connectivity, delay },
    );

    await flush();
    net.goOnline();
    await flush();
    expect(calls).toBe(2);
    expect(net.waiting()).toBe(1);

    net.goOnline();
    expect(await result).toBe("module");
    expect(calls).toBe(3);
  });

  // Safari keeps a failed module import for the rest of the page's life, so
  // every retry after reconnecting fails the same way.
  test("gives up when retries keep failing after reconnecting", async () => {
    const net = fakeNetwork(false);
    const { delay, pauses } = fakeDelay();
    let calls = 0;
    const result = loadWhenOnline(
      async () => {
        throw new TypeError(`attempt ${++calls}`);
      },
      { connectivity: net.connectivity, delay },
    );

    await flush();
    net.goOnline();
    await expect(result).rejects.toThrow("attempt 3");
    expect(pauses).toEqual([RETRY_DELAY_MS]);
  });
});
