import { expect, test } from "./fixtures";

// Profile hover cards (issue #562): on a desktop, resting the mouse on an
// `@mention` or an author name previews that profile in place.

test("hovering a mention previews the profile, and Message opens a docked chat", async ({
  page,
  createUser,
  signUp,
}) => {
  const bob = await createUser();
  const me = await signUp(page);

  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill("#content", `Say hi to @${bob.username} everyone`);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");

  const post = page.getByRole("article").first();
  const mention = post.getByRole("link", {
    name: `@${bob.username}`,
    exact: true,
  });
  const card = page.getByTestId("profile-hover-card");

  await mention.hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText(`@${bob.username}`);
  await expect(card.getByRole("link", { name: "View profile" })).toBeVisible();

  // Escape dismisses it.
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // Moving off the trigger closes it too.
  await page.mouse.move(0, 0);
  await mention.hover();
  await expect(card).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);

  // "Message" opens the conversation as a docked window without leaving
  // the feed.
  await mention.hover();
  await card.getByRole("button", { name: "Message" }).click();
  await expect(
    page.getByRole("region", { name: `Chat with @${bob.username}` }),
  ).toBeVisible();
  await expect(page).toHaveURL("/");
  await expect(card).toHaveCount(0);

  // Your own card has no "Message" — just the profile link, which navigates.
  await page.mouse.move(0, 0);
  await post.getByRole("link", { name: new RegExp(me.username) }).hover();
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Message" })).toHaveCount(0);
  await card.getByRole("link", { name: "View profile" }).click();
  await expect(page).toHaveURL(/\/users\/\d+/);
  await expect(card).toHaveCount(0);
});
