import { expect, test } from "./fixtures";

// In-app notifications (issue #317): the header bell lights up live when
// something happens to you, and the inbox links back to it.

test("an @mention lights up the bell live and the inbox links to the post", async ({
  browser,
  injectApiUrl,
  signUp,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const alice = await signUp(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const bob = await signUp(pageB);

  await expect(
    pageA.getByRole("link", { name: "Notifications", exact: true }),
  ).toBeVisible();

  await pageB.goto("/posts/new");
  await pageB.getByRole("button", { name: "Text" }).click();
  await pageB.fill("#content", `Hey @${alice.username}, look at this`);
  await pageB.getByRole("button", { name: "Post" }).click();
  await expect(pageB).toHaveURL("/");

  // No reload on Alice's side — the realtime push updates the badge.
  const bell = pageA.getByRole("link", { name: "Notifications (1 unread)" });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(pageA).toHaveURL("/notifications");

  const row = pageA.getByRole("button", {
    name: new RegExp(`${bob.username}.*mentioned you in a post`),
  });
  await expect(row).toContainText("look at this");
  await row.click();
  await expect(pageA).toHaveURL(/\/posts\/\d+/);
  await expect(
    pageA.getByRole("link", { name: "Notifications", exact: true }),
  ).toBeVisible();
});

test("a game invite lands in the inbox and opens the lobby", async ({
  browser,
  injectApiUrl,
  signUp,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const alice = await signUp(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const bob = await signUp(pageB);

  await pageA.goto("/games/typing");
  await pageA.getByRole("button", { name: "New lobby" }).click();
  await expect(pageA.getByText("Waiting room")).toBeVisible();
  const lobbyPath = new URL(pageA.url()).pathname;

  await pageA.getByRole("button", { name: "Invite players" }).click();
  await pageA.getByLabel("Search users to invite").fill(bob.username);
  await pageA.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(pageA.getByRole("button", { name: "Invited" })).toBeVisible();

  await pageB.getByRole("link", { name: "Notifications (1 unread)" }).click();
  await pageB
    .getByRole("button", {
      name: new RegExp(`${alice.username}.*invited you to a Type Race race`),
    })
    .click();
  await expect(pageB).toHaveURL(lobbyPath);
  await expect(
    pageB.getByRole("button", { name: "Join the race" }),
  ).toBeVisible();
});
