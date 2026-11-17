import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { E2E_TARGET } from "./target";

// A tab on a build that's no longer deployed (lib/staleBuild.ts): the games
// routes' chunk isn't precached, and once a deploy has removed it the static
// host answers its URL with the SPA fallback — index.html, 200, text/html —
// which the browser refuses to run as a module.

// The arcade route's component chunk: its content-hashed file in the build,
// the split source module under `vite dev`.
function isArcadeChunk(url: URL): boolean {
  return E2E_TARGET === "build"
    ? /^\/assets\/games-[\w-]+\.js$/.test(url.pathname)
    : url.pathname === "/src/routes/games/index.tsx" &&
        url.searchParams.has("tsr-split");
}

// Serves index.html in place of the arcade chunk for its first `times`
// requests, the way the host does once the chunk is gone. Returns how many
// requests it has seen.
async function removeArcadeChunk(page: Page, times: number) {
  let requests = 0;
  await page.route(isArcadeChunk, async (route) => {
    requests += 1;
    if (requests > times) return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    });
  });
  return () => requests;
}

const STALE_CHUNK_ERRORS = [
  /Failed to load module script/,
  /Failed to fetch dynamically imported module/,
];

test("a page whose chunk a deploy removed reloads onto the new build", async ({
  page,
  signUp,
  allowConsoleErrors,
}) => {
  allowConsoleErrors(...STALE_CHUNK_ERRORS);
  await signUp(page);
  // Missing for the first load and for TanStack Router's own reload, which
  // (with a service worker) would land on the same old shell again.
  const requests = await removeArcadeChunk(page, 2);

  await page.goto("/games");

  await expect(page.getByRole("heading", { name: "Arcade" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(requests()).toBe(3);
});

test("a chunk that stays missing shows the error once instead of reloading forever", async ({
  page,
  signUp,
  allowConsoleErrors,
}) => {
  allowConsoleErrors(...STALE_CHUNK_ERRORS);
  await signUp(page);
  const requests = await removeArcadeChunk(page, Infinity);

  await page.goto("/games");

  const alert = page.getByRole("alert");
  await expect(
    alert.getByRole("heading", { name: "Something went wrong" }),
  ).toBeVisible();
  await expect(alert).toContainText("didn't finish loading");
  // The first load, TanStack Router's reload and this page's one.
  expect(requests()).toBe(3);

  // Asking again still reloads.
  await alert.getByRole("button", { name: "Reload" }).click();
  await expect.poll(requests).toBe(4);
  await expect(
    alert.getByRole("heading", { name: "Something went wrong" }),
  ).toBeVisible();
});
