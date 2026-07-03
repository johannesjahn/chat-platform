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
