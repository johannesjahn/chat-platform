import { expect, test } from "./fixtures";
import { registerViaUi } from "./helpers";

test("starting a direct chat, sending a message, and seeing it marked read", async ({
  browser,
  injectApiUrl,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const { username: usernameA } = await registerViaUi(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const { username: usernameB } = await registerViaUi(pageB);

  // A starts a direct chat with B from the "New chat" picker.
  await pageA.goto("/chats/new");
  await pageA.getByRole("button", { name: "Direct message" }).click();
  await pageA.fill("#user-search", usernameB);
  await pageA.getByRole("button", { name: `@${usernameB}` }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);

  await pageA.fill(
    "textarea",
    "Hey there, this is a message from the e2e suite",
  );
  await pageA.keyboard.press("Enter");
  await expect(
    pageA.getByText("Hey there, this is a message from the e2e suite"),
  ).toBeVisible();

  // B sees the chat show up in their list with an unread badge...
  await pageB.goto("/chats");
  const chatRow = pageB.getByRole("link", {
    name: new RegExp(`@${usernameA}`),
  });
  await expect(chatRow).toBeVisible();
  await expect(chatRow.getByTestId("unread-badge")).toHaveText("1");

  // ...and once opened, the message is visible and the badge disappears.
  await chatRow.click();
  await expect(pageB).toHaveURL(/\/chats\/\d+/);
  await expect(
    pageB.getByText("Hey there, this is a message from the e2e suite"),
  ).toBeVisible();
  await pageB.goto("/chats");
  await expect(chatRow.getByTestId("unread-badge")).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

test("group chats can be created, renamed by the creator, and show all participants", async ({
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
  await pageA.getByRole("button", { name: "Group chat" }).click();
  await pageA.fill("#group-title", "Playwright squad");
  await pageA.fill("#user-search", usernameB);
  await pageA.getByRole("button", { name: `@${usernameB}` }).click();
  await pageA.getByRole("button", { name: /^Create group/ }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);
  await expect(pageA.getByText("Playwright squad")).toBeVisible();
  await expect(pageA.getByText("2 participants")).toBeVisible();

  // Only the creator can rename — the rename control shouldn't even render
  // for B, and the chat still shows up in B's list under the old name.
  await pageB.goto("/chats");
  await expect(pageB.getByText("Playwright squad")).toBeVisible();
  await pageB.getByText("Playwright squad").click();
  await expect(pageB.getByRole("button", { name: "Rename chat" })).toHaveCount(
    0,
  );

  await pageA.getByRole("button", { name: "Rename chat" }).click();
  await pageA.fill("input", "Renamed squad");
  await pageA.keyboard.press("Enter");
  await expect(pageA.getByText("Renamed squad")).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test("long messages are collapsed behind a Show more toggle", async ({
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

  const longContent = "Lorem ipsum dolor sit amet. ".repeat(20);
  await pageA.fill("textarea", longContent);
  await pageA.keyboard.press("Enter");

  const showMore = pageA.getByRole("button", { name: "Show more" });
  await expect(showMore).toBeVisible();
  await showMore.click();
  await expect(pageA.getByRole("button", { name: "Show less" })).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test("the creator can add participants to a group chat, and the new participant sees it in their list", async ({
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

  const contextC = await browser.newContext();
  await injectApiUrl(contextC);
  const pageC = await contextC.newPage();
  const { username: usernameC } = await registerViaUi(pageC);

  await pageA.goto("/chats/new");
  await pageA.getByRole("button", { name: "Group chat" }).click();
  await pageA.fill("#group-title", "Add participants test");
  await pageA.fill("#user-search", usernameB);
  await pageA.getByRole("button", { name: `@${usernameB}` }).click();
  await pageA.getByRole("button", { name: /^Create group/ }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);
  await expect(pageA.getByText("2 participants")).toBeVisible();

  await pageA.getByRole("button", { name: "Add participants" }).click();
  await pageA.getByPlaceholder("Search users to add…").fill(usernameC);
  await pageA.getByRole("button", { name: `@${usernameC}` }).click();
  await pageA.getByRole("button", { name: /^Add 1/ }).click();
  await expect(pageA.getByText("3 participants")).toBeVisible();

  // The newly added participant now sees the chat in their own list.
  await pageC.goto("/chats");
  await expect(pageC.getByText("Add participants test")).toBeVisible();

  await contextA.close();
  await contextB.close();
  await contextC.close();
});

test("navigating directly to a chat you can't access shows a not-found message", async ({
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
  const chatId = pageA.url().split("/").pop();

  const contextC = await browser.newContext();
  await injectApiUrl(contextC);
  const pageC = await contextC.newPage();
  await registerViaUi(pageC);

  // A chat id that doesn't exist at all...
  await pageC.goto("/chats/999999");
  await expect(pageC.getByText("Chat not found")).toBeVisible();

  // ...and a real chat C just isn't a participant in — both show the same
  // fallback rather than leaking whether the chat exists.
  await pageC.goto(`/chats/${chatId}`);
  await expect(pageC.getByText("Chat not found")).toBeVisible();

  await contextA.close();
  await contextB.close();
  await contextC.close();
});

test("a message sent by one user appears on the other's already-open chat via the websocket push", async ({
  browser,
  injectApiUrl,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const { username: usernameA } = await registerViaUi(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const { username: usernameB } = await registerViaUi(pageB);

  await pageA.goto("/chats/new");
  await pageA.getByRole("button", { name: "Direct message" }).click();
  await pageA.fill("#user-search", usernameB);
  await pageA.getByRole("button", { name: `@${usernameB}` }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);
  const chatId = pageA.url().split("/").pop();

  // B opens the same chat and just leaves it open — no reload from here on,
  // so anything B sees has to come from the `/ws` push invalidating the
  // query, not a fresh load.
  await pageB.goto(`/chats/${chatId}`);
  await expect(pageB.getByText(`@${usernameA}`)).toBeVisible();

  await pageA.fill("textarea", "Message sent while B is watching");
  await pageA.keyboard.press("Enter");

  await expect(pageB.getByText("Message sent while B is watching")).toBeVisible(
    { timeout: 10_000 },
  );

  await contextA.close();
  await contextB.close();
});

test("infinite scroll stops requesting more messages once the oldest one is loaded", async ({
  browser,
  injectApiUrl,
  page,
  request,
  apiUrl,
}) => {
  // Seeding 130 messages one HTTP request at a time (below), plus draining
  // several rounds of `loadEarlier` pagination, comfortably exceeds the
  // default 30s test timeout.
  test.setTimeout(90_000);

  await registerViaUi(page);

  const otherContext = await browser.newContext();
  await injectApiUrl(otherContext);
  const otherPage = await otherContext.newPage();
  const { username: otherUsername } = await registerViaUi(otherPage);
  await otherContext.close();

  await page.goto("/chats/new");
  await page.getByRole("button", { name: "Direct message" }).click();
  await page.fill("#user-search", otherUsername);
  await page.getByRole("button", { name: `@${otherUsername}` }).click();
  await expect(page).toHaveURL(/\/chats\/\d+/);
  const chatId = page.url().split("/").pop();

  // More messages than MESSAGES_MAX_LIMIT (100) so the pagination anchor has
  // to walk all the way back to the true offset 0 through several
  // `loadEarlier` pages — the case that used to keep re-triggering requests
  // even after the oldest message had already been loaded.
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const totalMessages = 130;
  for (let i = 0; i < totalMessages; i++) {
    const response = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      data: { contentType: "text", content: `Seeded message ${i}` },
    });
    expect(response.ok()).toBe(true);
  }

  let messagesRequestCount = 0;
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (
      url.pathname === `/chats/${chatId}/messages` &&
      req.method() === "GET"
    ) {
      messagesRequestCount++;
    }
  });

  await page.reload();
  await expect(page.getByText("Seeded message 129")).toBeVisible();

  const scrollContainer = page.getByTestId("chat-scroll");

  // Dispatch the scroll event explicitly rather than relying on the
  // browser's native scroll-event semantics (which only fire when scrollTop
  // actually changes) — this exercises `handleScroll`'s own `hasEarlier`
  // guard directly instead of depending on incidental scroll-position
  // physics.
  async function scrollToTop() {
    await scrollContainer.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
  }

  // Repeatedly scroll to the top and give each `loadEarlier` fetch a moment
  // to settle. MESSAGES_PAGE_SIZE is 10 and there are 130 seeded messages,
  // so reaching offset 0 takes on the order of a dozen scroll-triggered
  // fetches.
  for (let i = 0; i < 20; i++) {
    await scrollToTop();
    await page.waitForTimeout(300);
    if (await page.getByText("Seeded message 0").isVisible()) break;
  }
  await expect(page.getByText("Seeded message 0")).toBeVisible();

  const countOnceOldestLoaded = messagesRequestCount;

  // With the bug, reaching offset 0 in a chat longer than
  // MESSAGES_MAX_LIMIT flipped `hasEarlier` back to true, so every further
  // scroll-to-top kept sending another pagination request forever.
  for (let i = 0; i < 5; i++) {
    await scrollToTop();
    await page.waitForTimeout(200);
  }

  expect(messagesRequestCount).toBe(countOnceOldestLoaded);
});
