import { expect, test } from "./fixtures";
import { registerViaUi } from "./helpers";

test("losing connectivity mid-session keeps already-loaded messages on screen and shows an offline banner, and persists the cache to localStorage for a later reload", async ({
  browser,
  injectApiUrl,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  await registerViaUi(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const { username: usernameB } = await registerViaUi(pageB);

  await pageA.goto("/chats/new");
  await pageA.getByRole("button", { name: "Direct message" }).click();
  await pageA.fill("#user-search", usernameB);
  await pageA.getByRole("button", { name: `@${usernameB}` }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);

  await pageA.fill("textarea", "Message loaded before going offline");
  await pageA.keyboard.press("Enter");
  await expect(
    pageA.getByText("Message loaded before going offline"),
  ).toBeVisible();

  // Losing connectivity while the chat is already open and its data already
  // fetched — the primary scenario from issue #145 — must not blank or
  // error the view: the offline banner appears, and the already-rendered
  // message stays exactly where it was.
  await contextA.setOffline(true);
  await expect(pageA.getByRole("status")).toContainText("You're offline");
  await expect(
    pageA.getByText("Message loaded before going offline"),
  ).toBeVisible();

  // The sync persister throttles writes (default 1s, see query.ts) but
  // isn't network-dependent, so it still flushes while offline. This
  // directly confirms the chat data made it into the persisted snapshot
  // that a later reload (impossible to drive in this offline dev-server
  // e2e setup, since there's no service worker to serve the app shell
  // without a network — see vite.pwa-options.ts) would rehydrate from.
  await expect
    .poll(() =>
      pageA.evaluate(() => localStorage.getItem("chat-platform-query-cache")),
    )
    .toContain("Message loaded before going offline");

  await contextA.close();
  await contextB.close();
});

test("visiting a chat with no cached data during a connectivity failure shows an offline-specific message, not a generic not-found", async ({
  page,
  apiUrl,
}) => {
  // `context.setOffline` blocks the dev server's own asset requests too (no
  // service worker in this dev-server e2e setup to serve the app shell —
  // see the reload test above), so a real full-page `goto` while offline
  // can't be driven here at all. Aborting just the one API request instead
  // reproduces the same network-level failure (a rejected `fetch()`, not a
  // decoded HTTP error) that a genuinely offline, never-cached visit hits.
  await registerViaUi(page);
  await page.route(`${apiUrl}/chats/999999`, (route) => route.abort("failed"));
  await page.goto("/chats/999999");

  await expect(page.getByText("Can't load this conversation")).toBeVisible();
  await expect(
    page.getByText(
      "You're offline, and this conversation hasn't been loaded on this device yet.",
    ),
  ).toBeVisible();
  await expect(page.getByText("This conversation may not exist")).toHaveCount(
    0,
  );
});

test("a failed request doesn't blank already-loaded posts behind an error message", async ({
  page,
  apiUrl,
}) => {
  await registerViaUi(page);
  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill("#content", "Post loaded before the network hiccup");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByText("Post loaded before the network hiccup"),
  ).toBeVisible();

  // The sync persister throttles writes (default 1s, see query.ts) — wait
  // for it to actually flush before reloading, or the persisted snapshot
  // a reload restores from wouldn't have the post yet regardless of this
  // test's fix.
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("chat-platform-query-cache")),
    )
    .toContain("Post loaded before the network hiccup");

  // A real network-level failure (server unreachable while the browser
  // still thinks it's online) throws instead of the pause `setOffline`
  // (used above) produces — that used to replace the already-rendered feed
  // with "Could not load posts: Failed to fetch" instead of leaving it in
  // place.
  await page.route(`${apiUrl}/posts*`, (route) => route.abort("failed"));
  await page.reload();

  await expect(
    page.getByText("Post loaded before the network hiccup"),
  ).toBeVisible();
  await expect(page.getByText("Could not load posts:")).toHaveCount(0);
});

test("the composer disables sending while offline instead of failing the request", async ({
  browser,
  injectApiUrl,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  await registerViaUi(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const { username: usernameB } = await registerViaUi(pageB);

  await pageA.goto("/chats/new");
  await pageA.getByRole("button", { name: "Direct message" }).click();
  await pageA.fill("#user-search", usernameB);
  await pageA.getByRole("button", { name: `@${usernameB}` }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);
  // Wait for the composer to actually mount (chat detail + messages both
  // loaded) before flipping the context offline, so `setOffline` doesn't
  // race the chat page's own initial data fetch.
  await expect(pageA.locator("textarea")).toBeVisible();

  await contextA.setOffline(true);
  await pageA.fill("textarea", "Should not be sendable while offline");
  await expect(
    pageA.getByRole("button", { name: "Send message (offline)" }),
  ).toBeDisabled();
  await expect(
    pageA.getByText("You're offline — sending is disabled"),
  ).toBeVisible();

  await contextA.close();
  await contextB.close();
});
