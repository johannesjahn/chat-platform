/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { type Connectivity, loadWhenOnline } from "./lazy";

// A switchable stand-in for `navigator.onLine` and the `online` event.
function fakeConnectivity(online: boolean) {
  let listeners: (() => void)[] = [];
  const connectivity: Connectivity = {
    isOnline: () => online,
    whenOnline: () => new Promise((resolve) => listeners.push(resolve)),
  };
  const goOnline = () => {
    online = true;
    const fire = listeners;
    listeners = [];
    for (const listener of fire) listener();
  };
  return {
    connectivity,
    goOnline,
    goOffline: () => (online = false),
    waiting: () => listeners.length,
  };
}

// Lets pending promise callbacks run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("loadWhenOnline", () => {
  test("resolves with the first successful load", async () => {
    const { connectivity } = fakeConnectivity(true);
    let calls = 0;
    const result = await loadWhenOnline(async () => {
      calls++;
      return "module";
    }, connectivity);
    expect(result).toBe("module");
    expect(calls).toBe(1);
  });

  test("rejects straight away when the load fails while online", async () => {
    const { connectivity, waiting } = fakeConnectivity(true);
    let calls = 0;
    const error = new TypeError("Failed to fetch dynamically imported module");
    await expect(
      loadWhenOnline(async () => {
        calls++;
        throw error;
      }, connectivity),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(waiting()).toBe(0);
  });

  test("waits for the connection to come back, then retries", async () => {
    const net = fakeConnectivity(true);
    let calls = 0;
    const result = loadWhenOnline(async () => {
      calls++;
      if (calls === 1) {
        // The connection drops while the chunk is downloading.
        net.goOffline();
        throw new TypeError("Failed to fetch dynamically imported module");
      }
      return "module";
    }, net.connectivity);

    await flush();
    expect(calls).toBe(1);
    expect(net.waiting()).toBe(1);

    net.goOnline();
    expect(await result).toBe("module");
    expect(calls).toBe(2);
  });

  test("keeps waiting while retries keep failing offline", async () => {
    const net = fakeConnectivity(false);
    let calls = 0;
    const result = loadWhenOnline(async () => {
      calls++;
      if (calls < 3) {
        // `online` fired, but the connection drops again before the retry
        // gets through.
        net.goOffline();
        throw new TypeError("Failed to fetch");
      }
      return "module";
    }, net.connectivity);

    await flush();
    net.goOnline();
    await flush();
    expect(calls).toBe(2);
    expect(net.waiting()).toBe(1);

    net.goOnline();
    expect(await result).toBe("module");
    expect(calls).toBe(3);
  });

  test("rejects when the retry after reconnecting fails online", async () => {
    const net = fakeConnectivity(false);
    let calls = 0;
    const result = loadWhenOnline(async () => {
      calls++;
      throw new TypeError(`attempt ${calls}`);
    }, net.connectivity);

    await flush();
    net.goOnline();
    await expect(result).rejects.toThrow("attempt 2");
    expect(calls).toBe(2);
  });
});
