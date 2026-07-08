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
