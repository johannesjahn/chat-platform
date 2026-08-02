import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures";
import { fakeOnScreenKeyboard, registerViaUi } from "./helpers";

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
  // for B inside the group settings dialog, and the chat still shows up in
  // B's list under the old name.
  await pageB.goto("/chats");
  await expect(pageB.getByText("Playwright squad")).toBeVisible();
  await pageB.getByText("Playwright squad").click();
  await pageB.getByRole("button", { name: "Manage group" }).click();
  await expect(pageB.getByRole("button", { name: "Rename chat" })).toHaveCount(
    0,
  );

  await pageA.getByRole("button", { name: "Manage group" }).click();
  await pageA.getByRole("button", { name: "Rename chat" }).click();
  // Target the rename field specifically (placeholder) rather than a bare
  // "input" selector — the app header now also has a search input, so a
  // page-wide "input" would be ambiguous / hit the wrong field.
  await pageA.getByPlaceholder("Group name").fill("Renamed squad");
  await pageA.keyboard.press("Enter");
  // Close the dialog so the assertion matches only the chat header title.
  await pageA.getByRole("button", { name: "Close group settings" }).click();
  await expect(pageA.getByText("Renamed squad")).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test("a user can redeem a group invite through the join page and via a direct invite link", async ({
  browser,
  injectApiUrl,
  apiUrl,
  request,
}) => {
  // This one spins up four browser contexts and registers four users through
  // the UI (seed + A + B + C), which alone flirts with the default 30s budget
  // on the slower sharded CI runners — every assertion passes, it just tips
  // over during teardown. Give it the tripled "slow" budget so that timing
  // headroom, not a logic change, is what keeps it green.
  test.slow();
  // A seed user just so the group can be created (a group needs at least one
  // other participant); B and C below join purely through the invite flow.
  const contextSeed = await browser.newContext();
  await injectApiUrl(contextSeed);
  const pageSeed = await contextSeed.newPage();
  const { username: usernameSeed } = await registerViaUi(pageSeed);
  await contextSeed.close();

  // Owner A creates a group chat and mints an invite code for it. The code is
  // created over the API (the UI only ever exposes it truncated + via
  // clipboard) so the test can drive the join UI deterministically.
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  await registerViaUi(pageA);

  await pageA.goto("/chats/new");
  await pageA.getByRole("button", { name: "Group chat" }).click();
  await pageA.fill("#group-title", "Invite squad");
  await pageA.fill("#user-search", usernameSeed);
  await pageA.getByRole("button", { name: `@${usernameSeed}` }).click();
  await pageA.getByRole("button", { name: /^Create group/ }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);
  const chatId = pageA.url().split("/").pop();

  const sessionA = await pageA.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const inviteResponse = await request.post(
    `${apiUrl}/chats/${chatId}/invites`,
    {
      headers: { Authorization: `Bearer ${sessionA.accessToken}` },
      data: {},
    },
  );
  expect(inviteResponse.ok()).toBe(true);
  const { code } = await inviteResponse.json();

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  await registerViaUi(pageB);

  // Path 1: B pastes the code into the join page and clicks Continue. The
  // confirmation step (a child route) must actually render — the regression
  // was that `/chats/join/$code` never mounted because its parent join route
  // had no `<Outlet />`, so this page silently stayed on the form.
  await pageB.goto("/chats/join");
  await pageB.getByLabel("Invite link or code").fill(code);
  await pageB.getByRole("button", { name: "Continue" }).click();
  await expect(pageB).toHaveURL(`/chats/join/${code}`);
  await expect(pageB.getByText("You've been invited to a chat")).toBeVisible();

  await pageB.getByRole("button", { name: "Join chat" }).click();
  await expect(pageB).toHaveURL(/\/chats\/\d+/);
  await expect(pageB.getByText("Invite squad")).toBeVisible();

  // Path 2: a brand-new user opening the shared invite link directly (the
  // `<origin>/chats/join/<code>` shape the copy-link button produces) also
  // lands on the confirmation page rather than the join form.
  const contextC = await browser.newContext();
  await injectApiUrl(contextC);
  const pageC = await contextC.newPage();
  await registerViaUi(pageC);

  await pageC.goto(`/chats/join/${code}`);
  await expect(pageC.getByText("You've been invited to a chat")).toBeVisible();
  await pageC.getByRole("button", { name: "Join chat" }).click();
  await expect(pageC).toHaveURL(/\/chats\/\d+/);
  await expect(pageC.getByText("Invite squad")).toBeVisible();

  await contextA.close();
  await contextB.close();
  await contextC.close();
});

test("messages are grouped under a sticky day separator (issue #307)", async ({
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

  await pageA.fill("textarea", "First message of the day");
  await pageA.keyboard.press("Enter");
  await expect(pageA.getByText("First message of the day")).toBeVisible();

  // A single separator labelled "Today" is inserted ahead of the first
  // message — all of today's messages share one day, so there's exactly one.
  const separators = pageA.getByTestId("date-separator");
  await expect(separators).toHaveCount(1);
  await expect(separators.first()).toHaveText("Today");

  // Sending another message the same day doesn't add a second separator.
  await pageA.fill("textarea", "Second message, same day");
  await pageA.keyboard.press("Enter");
  await expect(pageA.getByText("Second message, same day")).toBeVisible();
  await expect(separators).toHaveCount(1);

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

  await pageA.getByRole("button", { name: "Manage group" }).click();
  await pageA
    .getByRole("button", { name: "Add participants", exact: true })
    .click();
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

test("sending a message doesn't leave a duplicate copy in the sender's own view (issue #203)", async ({
  browser,
  injectApiUrl,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();

  // The server publishes the `chat_updated` push for a sent message *before*
  // it returns the send's own HTTP response (see `notifyChatUpdated` in
  // ChatsHandler.ts), so on an unthrottled localhost connection the WS event
  // reliably reaches the client before (or interleaved with) the mutation's
  // own response — too fast for the client-side race in `useChatMessages`
  // (chats.ts) to reproduce. Delaying every `chat_updated` push forces the
  // opposite, real-world-representative ordering: the mutation's
  // `appendSentMessage` optimistic write lands first, then the WS-triggered
  // catch-up refetch runs against a cache that already has the message.
  await pageA.routeWebSocket(
    (url) => url.pathname === "/ws",
    (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        if (typeof message === "string" && message.includes("chat_updated")) {
          setTimeout(() => ws.send(message), 500);
          return;
        }
        ws.send(message);
      });
    },
  );
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

  // The bug only reproduces once `useChatMessages` has already anchored a
  // real (non-null) cursor from a prior load — a brand-new empty chat's very
  // first fetch has no cursor yet, so its first sent message always takes
  // the "true first load" branch, which replaces the array wholesale and
  // can't duplicate. Send a first message to establish that cursor before
  // sending the one we actually check for duplication.
  await pageA.fill("textarea", "First message, just to anchor the cursor");
  await pageA.keyboard.press("Enter");
  await expect(
    pageA.getByText("First message, just to anchor the cursor"),
  ).toBeVisible();
  await pageA.waitForTimeout(1_000);

  const messageText = "This message must not appear twice";
  await pageA.fill("textarea", messageText);
  await pageA.keyboard.press("Enter");

  const messageLocator = pageA.getByText(messageText);
  await expect(messageLocator).toBeVisible();
  // Give the deliberately-delayed `chat_updated` push time to arrive and
  // trigger `useChatMessages`'s catch-up refetch before asserting there's
  // still only one copy of the message.
  await pageA.waitForTimeout(1_500);
  await expect(messageLocator).toHaveCount(1);

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

test("reopening an already-visited chat still paginates instead of loading its whole history", async ({
  browser,
  injectApiUrl,
  page,
  request,
  apiUrl,
}) => {
  await registerViaUi(page);

  const otherContext = await browser.newContext();
  await injectApiUrl(otherContext);
  const otherPage = await otherContext.newPage();
  const { username: otherUsername } = await registerViaUi(otherPage);
  await otherContext.close();

  // Client-side navigation throughout (no `page.goto` after this point) is
  // essential: the bug only reproduces while the SPA's in-memory React Query
  // cache survives across a route change, which a `page.goto`/reload would
  // wipe entirely, masking the issue.
  await page.goto("/chats/new");
  await page.getByRole("button", { name: "Direct message" }).click();
  await page.fill("#user-search", otherUsername);
  await page.getByRole("button", { name: `@${otherUsername}` }).click();
  await expect(page).toHaveURL(/\/chats\/\d+/);
  const chatId = page.url().split("/").pop();

  // This first mount fetches (and caches) the empty message list for this
  // brand-new chat.
  await expect(page.getByText("No messages yet")).toBeVisible();

  // Leave the chat (client-side nav back to the list) before seeding, so the
  // now-unmounted `ChatView`/`useChatMessages` isn't live-reacting to the
  // seeded messages via WS — only its stale cached page should remain.
  await page.getByRole("link", { name: "Back to chats" }).click();
  await expect(page).toHaveURL("/chats");

  // More than MESSAGES_PAGE_SIZE (10) so a "load everything" regression is
  // visibly distinguishable from the intended small first page, but well
  // under MESSAGES_MAX_LIMIT (100) so a full-history load would show every
  // seeded message at once.
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const totalMessages = 15;
  for (let i = 0; i < totalMessages; i++) {
    const response = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      data: { contentType: "text", content: `Seeded message ${i}` },
    });
    expect(response.ok()).toBe(true);
  }

  const messagesLimits: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (
      url.pathname === `/chats/${chatId}/messages` &&
      req.method() === "GET"
    ) {
      messagesLimits.push(url.searchParams.get("limit") ?? "");
    }
  });

  // Reopen the same chat via a client-side link click (well within the query
  // cache's default 5min retention). With the bug, the hook mistook the
  // leftover cached page for a "re-anchor after MESSAGES_MAX_LIMIT" and
  // re-fetched with limit=100 instead of the intended 10-message first page,
  // dumping the whole (short) history in at once.
  await page
    .getByRole("link", { name: new RegExp(`@${otherUsername}`) })
    .click();
  await expect(page).toHaveURL(`/chats/${chatId}`);
  await expect(page.getByText("Seeded message 14")).toBeVisible();

  expect(messagesLimits).toEqual(["10"]);
  await expect(page.getByText("Seeded message 0")).not.toBeVisible();
});

test("a client that missed a chat_updated push while its socket was down catches up via a full refetch on reconnect (issue #54)", async ({
  browser,
  injectApiUrl,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();

  // Intercepts A's `/ws` connection so it can be dropped on demand instead
  // of relying on real network timing (e.g. `context.setOffline`, which can
  // take an unpredictable amount of time for the browser to notice an
  // already-open socket has gone dead). The first connection is forwarded to
  // the real backend immediately; every reconnect after that is held open
  // (never forwarded) until `releaseReconnect` is called, so the test can
  // deterministically keep A's client disconnected for exactly as long as it
  // takes B to send a message, rather than racing the client's own
  // (RECONNECT_BASE_MS-paced) reconnect attempt.
  let currentServer: WebSocketRoute | undefined;
  let connectionCount = 0;
  let releaseReconnect: () => void = () => {};
  const reconnectGate = new Promise<void>((resolve) => {
    releaseReconnect = resolve;
  });
  await pageA.routeWebSocket(
    (url) => url.pathname === "/ws",
    async (ws) => {
      connectionCount++;
      if (connectionCount > 1) await reconnectGate;
      currentServer = ws.connectToServer();
    },
  );

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
  await expect(pageA.getByText("No messages yet")).toBeVisible();

  // Drop A's live connection — its client notices via `onclose` and starts
  // reconnecting (see RECONNECT_BASE_MS in realtimeSocket.ts), but the
  // reconnect attempt is held open by the gate above, so A stays
  // disconnected until `releaseReconnect` is called below.
  await currentServer?.close();

  // While A has no live connection, B sends a message in the same chat. The
  // `chat_updated` push for it is never delivered to A — there's nothing
  // listening — so without a reconnect-triggered refetch, A would only see
  // it once some *later* event happened to touch this chat again.
  await pageB.goto(`/chats/${chatId}`);
  await expect(pageB.getByText(`@${usernameA}`)).toBeVisible();
  await pageB.fill("textarea", "Sent while A's socket was down");
  await pageB.keyboard.press("Enter");
  await expect(pageB.getByText("Sent while A's socket was down")).toBeVisible();

  // Now let A's reconnect through. The message shows up from the full
  // refetch `useRealtimeSocket` does on every `onopen`, without a page
  // reload — there was no live push to trigger the usual version-checked
  // path (issue #55).
  releaseReconnect();
  await expect(pageA.getByText("Sent while A's socket was down")).toBeVisible({
    timeout: 10_000,
  });

  await contextA.close();
  await contextB.close();
});

test("a long conversation fits the viewport and opens scrolled to the newest message", async ({
  page,
  request,
  apiUrl,
  browser,
  injectApiUrl,
}) => {
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

  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  // Comfortably more than fits on one screen, so the thread has to scroll.
  for (let i = 0; i < 30; i++) {
    const response = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      data: {
        contentType: "text",
        content: `Seeded message ${i} — long enough to wrap onto more than one line in the bubble.`,
      },
    });
    expect(response.ok()).toBe(true);
  }

  await page.reload();
  await expect(page.getByText("Seeded message 29")).toBeVisible();
  // The composer's auto-size and the message-in animations settle a beat
  // after the thread first paints — the assertions below are about where
  // things end up once they have.
  await page.waitForTimeout(1_000);

  // The whole conversation lives inside the viewport: the page itself must
  // not scroll, or the composer ends up below the fold and the thread has to
  // be chased with the *window* scrollbar — the fill-the-screen layout issue
  // #321 asked for, which `flex-1` alone silently didn't deliver.
  const pageScrollable = await page.evaluate(
    () =>
      document.documentElement.scrollHeight >
      document.documentElement.clientHeight + 1,
  );
  expect(pageScrollable).toBe(false);

  // ...and the thread's own scroll container is what scrolls, parked at the
  // bottom so the newest message is the one on screen.
  const scrollState = await page.getByTestId("chat-scroll").evaluate((el) => ({
    scrollable: el.scrollHeight > el.clientHeight,
    distanceFromBottom: Math.round(
      el.scrollHeight - el.scrollTop - el.clientHeight,
    ),
  }));
  expect(scrollState.scrollable).toBe(true);
  expect(scrollState.distanceFromBottom).toBeLessThanOrEqual(24);

  // The newest bubble is genuinely on screen, not just scrolled-to in theory.
  const viewportHeight = page.viewportSize()!.height;
  const newest = await page.getByText("Seeded message 29").boundingBox();
  expect(newest).not.toBeNull();
  expect(newest!.y).toBeGreaterThanOrEqual(0);
  expect(newest!.y + newest!.height).toBeLessThanOrEqual(viewportHeight);
});

test("the empty composer is one line tall and only grows once there's something to grow for", async ({
  page,
  browser,
  injectApiUrl,
}) => {
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

  // A narrow phone viewport, where the textarea is only ~150px wide and the
  // placeholder used to wrap over several lines.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("No messages yet")).toBeVisible();
  await page.waitForTimeout(500);

  const composer = page.locator("textarea");
  const height = () =>
    composer.evaluate((el) => Math.round(el.getBoundingClientRect().height));

  // An empty textarea reports its wrapped *placeholder* in `scrollHeight`, so
  // auto-sizing off that measurement used to open the composer ~136px tall —
  // five lines of hint text — before anything had been typed.
  const empty = await height();
  expect(empty).toBeLessThan(56);

  // Typing still grows it...
  await page.fill("textarea", "one\ntwo\nthree\nfour");
  await expect.poll(height).toBeGreaterThan(empty);

  // ...up to the max-h-40 ceiling, after which the textarea scrolls instead.
  await page.fill(
    "textarea",
    Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
  );
  await expect.poll(height).toBe(160);

  // ...and clearing it collapses back to a single line.
  await page.fill("textarea", "");
  await expect.poll(height).toBe(empty);

  // The keyboard hint moved out of the placeholder, but the field keeps the
  // same accessible name it had when the placeholder was providing one.
  await expect(composer).toHaveAccessibleName(
    "Write a message (Enter to send, Shift+Enter for a new line)",
  );
});

test("the chat fits the *visual* viewport, not the layout viewport the keyboard lies about", async ({
  page,
  browser,
  injectApiUrl,
}) => {
  // A phone-shaped screen, where the composer being pushed off the bottom is
  // the difference between a usable chat and an unusable one.
  await page.setViewportSize({ width: 390, height: 844 });

  await fakeOnScreenKeyboard(page);

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
  await expect(page.getByText("No messages yet")).toBeVisible();

  const appHeight = () =>
    page.evaluate(() =>
      Math.round(
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--app-height",
          ),
        ),
      ),
    );
  const composerBottom = async () => {
    const box = await page.locator("textarea").boundingBox();
    expect(box).not.toBeNull();
    return box!.y + box!.height;
  };

  // Unobstructed, `--app-height` is just the viewport height...
  await expect.poll(appHeight).toBe(844);

  // ...and with the "keyboard" up it follows the visual viewport down, even
  // though the layout viewport (and `100dvh` with it) hasn't moved. This is
  // the whole bug: the layout used to stay 844px tall, putting its bottom
  // 344px behind the keyboard with no page scroll to chase it (#342 made the
  // page deliberately unscrollable), so the composer and the newest messages
  // were simply unreachable.
  await page.evaluate(() => window.__shrinkVisualViewport(500));
  await expect.poll(appHeight).toBe(500);
  expect(
    await page.evaluate(
      () => document.documentElement.clientHeight, // the layout viewport, unchanged
    ),
  ).toBe(844);

  // The composer is the bottom-most thing in the layout, so it's the proof:
  // it has to sit inside the 500px that are actually visible.
  await expect.poll(composerBottom).toBeLessThanOrEqual(500);

  // And it comes back when the keyboard closes.
  await page.evaluate(() => window.__shrinkVisualViewport(null));
  await expect.poll(appHeight).toBe(844);
  await expect.poll(composerBottom).toBeLessThanOrEqual(844);
  expect(await composerBottom()).toBeGreaterThan(500);
});

test("the on-screen keyboard leaves the thread readable instead of collapsing it to nothing", async ({
  page,
  request,
  apiUrl,
  browser,
  injectApiUrl,
}) => {
  test.setTimeout(90_000);

  // A phone, where every row of chrome is a row of messages you don't get.
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeOnScreenKeyboard(page);

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

  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  // Enough that the thread has to scroll, so "parked at the bottom" means
  // something.
  for (let i = 0; i < 12; i++) {
    const response = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      data: { contentType: "text", content: `Seeded message ${i}` },
    });
    expect(response.ok()).toBe(true);
  }

  await page.reload();
  await expect(page.getByText("Seeded message 11")).toBeVisible();
  // The composer's auto-size and the message-in animations settle a beat after
  // the thread first paints.
  await page.waitForTimeout(1_000);

  const nav = page.locator("nav");
  // On a phone the conversation is the whole screen: the site nav's three
  // wrapped rows (~145px, more once the status-bar inset is added) hand their
  // space to the thread, and the chat's own header — back button included — is
  // the only chrome left.
  await expect(nav).toBeHidden();

  const thread = page.getByTestId("chat-scroll");
  const threadState = () =>
    thread.evaluate((el) => ({
      height: Math.round(el.clientHeight),
      distanceFromBottom: Math.round(
        el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    }));
  const pageScrollable = () =>
    page.evaluate(
      () =>
        document.documentElement.scrollHeight >
        document.documentElement.clientHeight + 1,
    );

  expect((await threadState()).height).toBeGreaterThan(600);
  expect(await pageScrollable()).toBe(false);

  // Up comes the keyboard, taking a bit more than half the screen with it.
  // Waiting for `--app-height` to catch up first matters: the resize handler
  // coalesces into a rAF (see lib/viewport.ts), so measuring straight after
  // this call would still see the un-shrunk layout and pass for the wrong
  // reason.
  await page.evaluate(() => window.__shrinkVisualViewport(400));
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.round(
          parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--app-height",
            ),
          ),
        ),
      ),
    )
    .toBe(400);

  // The thread keeps a real, readable slice of what's left rather than being
  // squeezed to a sliver by the chrome above it: with the site nav still in
  // the layout, the header and composer alone accounted for nearly all of the
  // 400px — add a pinned-messages bar and typing meant looking at no messages
  // at all.
  const shrunk = await threadState();
  expect(shrunk.height).toBeGreaterThan(200);
  // ...and it's still parked at the newest message, not left mid-history by
  // the resize.
  expect(shrunk.distanceFromBottom).toBeLessThanOrEqual(24);

  // Everything that matters is inside the 400px that are actually visible —
  // and the page still can't be scrolled to reach anything that isn't.
  const composerTop = async () => {
    const box = await page.locator("textarea").boundingBox();
    expect(box).not.toBeNull();
    return box!.y;
  };
  const newest = await page.getByText("Seeded message 11").boundingBox();
  expect(newest).not.toBeNull();
  expect(newest!.y).toBeGreaterThanOrEqual(0);
  expect(newest!.y + newest!.height).toBeLessThanOrEqual(await composerTop());
  expect(await pageScrollable()).toBe(false);

  // The build-version tag stays out of the corner the composer now occupies.
  const versionTag = page.locator("[data-version-tag]");
  await expect(versionTag).toBeHidden();

  await page.evaluate(() => window.__shrinkVisualViewport(null));

  // The nav is back as soon as there's room for it...
  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(nav).toBeVisible();

  // ...and leaving the conversation hands the page back its ordinary
  // scrolling document behaviour rather than leaving it locked.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Back to chats" }).click();
  await expect(page).toHaveURL(/\/chats$/);
  await expect(nav).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-app-shell");

  // Back on an ordinary page the tag is visible again — and it rides the
  // *visible* bottom edge, not the layout viewport's. Fixed positioning
  // resolves against the latter, which the keyboard doesn't shrink, so the
  // `bottom`-anchored version of this used to leave the tag floating in the
  // middle of the screen whenever a keyboard was up (see VersionFooter).
  await expect(versionTag).toBeVisible();
  await page.evaluate(() => window.__shrinkVisualViewport(400));
  await expect
    .poll(async () => {
      const box = await versionTag.boundingBox();
      return box == null ? null : Math.round(box.y + box.height);
    })
    .toBeLessThanOrEqual(400);
});
