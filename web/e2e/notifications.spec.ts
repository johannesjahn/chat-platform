import { expect, test } from "./fixtures";

// In-app notifications (issue #317): the header bell lights up live when
// something happens to you, and the inbox links back to it. On a desktop the
// bell opens a popover of the newest ones (issue #554), with "See all" for
// the full inbox.

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
    pageA.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible();

  await pageB.goto("/posts/new");
  await pageB.getByRole("button", { name: "Text" }).click();
  await pageB.fill("#content", `Hey @${alice.username}, look at this`);
  await pageB.getByRole("button", { name: "Post" }).click();
  await expect(pageB).toHaveURL("/");

  // No reload on Alice's side — the realtime push updates the badge.
  const bell = pageA.getByRole("button", {
    name: "Notifications (1 unread)",
  });
  await expect(bell).toBeVisible();
  await bell.click();
  const popover = pageA.getByRole("dialog", { name: "Notifications" });
  await expect(
    popover.getByRole("button", {
      name: new RegExp(`${bob.username}.*mentioned you in a post`),
    }),
  ).toContainText("look at this");
  await popover.getByRole("link", { name: "See all notifications" }).click();
  await expect(pageA).toHaveURL("/notifications");
  await expect(popover).toHaveCount(0);

  const row = pageA.getByRole("main").getByRole("button", {
    name: new RegExp(`${bob.username}.*mentioned you in a post`),
  });
  await expect(row).toContainText("look at this");
  await row.click();
  await expect(pageA).toHaveURL(/\/posts\/\d+/);
  await expect(
    pageA.getByRole("button", { name: "Notifications", exact: true }),
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

  // Straight from the bell's popover this time.
  await pageB.getByRole("button", { name: "Notifications (1 unread)" }).click();
  await pageB
    .getByRole("dialog", { name: "Notifications" })
    .getByRole("button", {
      name: new RegExp(`${alice.username}.*invited you to play Type Race`),
    })
    .click();
  await expect(pageB).toHaveURL(lobbyPath);
  await expect(
    pageB.getByRole("button", { name: "Join the race" }),
  ).toBeVisible();
});
