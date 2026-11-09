import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { persistedQueryCache } from "./helpers";
import { E2E_TARGET } from "./target";

// The installed PWA (issue #740): what the service worker built from
// vite.pwa-options.ts makes possible. Only the production build has one, and
// every other spec blocks it (see playwright.config.ts), so this file opts
// back in — which also means `page.route` can't see what it serves.
test.skip(
  E2E_TARGET !== "build",
  "needs the production build's service worker (E2E_TARGET=build)",
);
test.use({ serviceWorkers: "allow" });

// Resolves once the service worker is active, i.e. has precached the whole
// build while it installed. It doesn't claim pages that are already open
// (no `clientsClaim`), so it's the *next* navigation that it controls — and
// from then on it can serve the app shell and every chunk with no network.
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

test("reloading a chat while offline brings back the app shell and the persisted conversation", async ({
  page,
  context,
  createUser,
  signUp,
}) => {
  const other = await createUser();
  await signUp(page);
  await waitForServiceWorker(page);

  await page.goto("/chats/new");
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Direct message" }).click();
  await page.fill("#user-search", other.username);
  await page.getByRole("button", { name: `@${other.username}` }).click();
  await expect(page).toHaveURL(/\/chats\/\d+/);
  const chatUrl = page.url();

  await page.fill("textarea", "Sent before the reload");
  await page.keyboard.press("Enter");
  // Confirmed by the server, not just a "sending" bubble — see the same
  // wait in offline.spec.ts.
  await expect(page.getByTestId("pending-message")).toHaveCount(0);
  await expect(
    page.getByRole("main").getByText("Sent before the reload"),
  ).toBeVisible();
  // The persister throttles its writes (see query.ts).
  await expect
    .poll(() => persistedQueryCache(page))
    .toContain("Sent before the reload");

  await context.setOffline(true);
  await page.reload();

  // The service worker answered the navigation with the cached shell, its
  // chunks came from the precache, and the conversation from the persisted
  // query cache — with no network at all.
  expect(page.url()).toBe(chatUrl);
  await expect(page.getByRole("status")).toContainText("You're offline");
  await expect(
    page.getByRole("main").getByText("Sent before the reload"),
  ).toBeVisible();

  // And it picks up again once the connection is back.
  await context.setOffline(false);
  await expect(
    page.getByRole("status").filter({ hasText: "You're offline" }),
  ).toHaveCount(0);
});
