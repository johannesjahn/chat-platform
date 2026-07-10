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
