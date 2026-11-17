/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  canReloadAutomatically,
  isStaleChunkError,
  RELOAD_COOLDOWN_MS,
  type ReloadDeps,
  reloadIntoLatestBuild,
} from "./staleBuild";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeBrowser() {
  const store = new Map<string, string>();
  let time = 1_000_000;
  const events: string[] = [];
  let finishActivation = () => {};
  const deps: ReloadDeps = {
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    },
    now: () => time,
    activateLatestBuild: () => {
      events.push("activate");
      return new Promise<void>((resolve) => {
        finishActivation = resolve;
      });
    },
    reload: () => void events.push("reload"),
  };
  return {
    deps,
    events,
    advance: (ms: number) => {
      time += ms;
    },
    activated: async () => {
      finishActivation();
      await flush();
    },
  };
}

describe("isStaleChunkError", () => {
  test("recognises each browser's failed dynamic import", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://x/assets/a.js",
      "error loading dynamically imported module: https://x/assets/a.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/a.css",
    ])
      expect(isStaleChunkError(new TypeError(message))).toBe(true);
  });

  test("leaves other errors alone", () => {
    expect(isStaleChunkError(new Error("boom"))).toBe(false);
    expect(
      isStaleChunkError("Failed to fetch dynamically imported module"),
    ).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
  });
});

describe("reloadIntoLatestBuild", () => {
  test("reloads only after the newest build has taken over", async () => {
    const browser = fakeBrowser();
    expect(reloadIntoLatestBuild({}, browser.deps)).toBe(true);
    await flush();
    expect(browser.events).toEqual(["activate"]);
    await browser.activated();
    expect(browser.events).toEqual(["activate", "reload"]);
  });

  test("still reloads when the update check fails", async () => {
    const browser = fakeBrowser();
    browser.deps.activateLatestBuild = () => Promise.reject(new Error("x"));
    reloadIntoLatestBuild({}, browser.deps);
    await flush();
    expect(browser.events).toEqual(["reload"]);
  });

  test("doesn't reload on its own twice within the cooldown", async () => {
    const browser = fakeBrowser();
    reloadIntoLatestBuild({}, browser.deps);
    browser.advance(RELOAD_COOLDOWN_MS - 1);
    expect(canReloadAutomatically(browser.deps)).toBe(false);
    expect(reloadIntoLatestBuild({}, browser.deps)).toBe(false);

    browser.advance(1);
    expect(canReloadAutomatically(browser.deps)).toBe(true);
    expect(reloadIntoLatestBuild({}, browser.deps)).toBe(true);
  });

  test("a reload the user asks for ignores the cooldown", () => {
    const browser = fakeBrowser();
    reloadIntoLatestBuild({}, browser.deps);
    expect(reloadIntoLatestBuild({ userInitiated: true }, browser.deps)).toBe(
      true,
    );
  });

  test("never reloads on its own when storage is unavailable", () => {
    const browser = fakeBrowser();
    browser.deps.storage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(canReloadAutomatically(browser.deps)).toBe(false);
    expect(reloadIntoLatestBuild({}, browser.deps)).toBe(false);
    expect(reloadIntoLatestBuild({ userInitiated: true }, browser.deps)).toBe(
      true,
    );
  });
});
