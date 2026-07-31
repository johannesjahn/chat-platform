import { expect, test } from "./fixtures";
import { registerViaUi } from "./helpers";

// `@mention` support (issue #318): autocomplete while composing, and a link
// to the mentioned user's profile once the content is rendered.

test("the post composer autocompletes an @mention, and the posted mention links to that profile", async ({
  page,
}) => {
  // Register the user who'll be mentioned first, then register (and stay
  // signed in as) the author — the second registration replaces the
  // session, so both accounts exist but only the author is logged in.
  const { username: mentioned } = await registerViaUi(page);
  await registerViaUi(page);

  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();

  // Typed key by key rather than `fill`ed, so the composer actually sees
  // the `@` and the partial name that trigger the suggestion lookup.
  const composer = page.locator("#content");
  await composer.pressSequentially(`Welcome @${mentioned.slice(0, 8)}`);

  const suggestion = page.getByRole("option", { name: `@${mentioned}` });
  await expect(suggestion).toBeVisible();

  // Enter picks the highlighted suggestion and completes the mention
  // (rather than being typed into the message).
  await page.keyboard.press("Enter");
  await expect(suggestion).toBeHidden();
  await expect(composer).toHaveValue(`Welcome @${mentioned} `);

  await composer.pressSequentially("to the feed");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");

  // The rendered post links the mention to the mentioned user's profile,
  // and the rest of the text is untouched.
  const post = page.getByRole("article").first();
  await expect(post).toContainText(`Welcome @${mentioned} to the feed`);
  await post.getByRole("link", { name: `@${mentioned}`, exact: true }).click();
  await expect(page).toHaveURL(/\/users\/\d+/);
  await expect(page.getByText(`@${mentioned}`).first()).toBeVisible();
});

test("an unknown @mention stays plain text", async ({ page }) => {
  await registerViaUi(page);

  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill("#content", "Paging @nobody_at_all about this");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");

  const post = page.getByRole("article").first();
  await expect(post).toContainText("Paging @nobody_at_all about this");
  await expect(post.getByRole("link", { name: "@nobody_at_all" })).toHaveCount(
    0,
  );
});

test("picking a chat mention with Enter completes it instead of sending the message", async ({
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

  const composer = pageA.locator("textarea");
  await composer.pressSequentially(`ping @${usernameB.slice(0, 8)}`);

  const suggestion = pageA.getByRole("option", { name: `@${usernameB}` });
  await expect(suggestion).toBeVisible();

  // Enter is "send" in this composer — while the suggestion list is open it
  // has to complete the mention instead, leaving the draft in place.
  await pageA.keyboard.press("Enter");
  await expect(composer).toHaveValue(`ping @${usernameB} `);

  // A second Enter, with the list closed, sends as usual — and the mention
  // arrives as a profile link for the recipient too.
  await pageA.keyboard.press("Enter");
  await expect(pageA.getByText(`ping @${usernameB}`)).toBeVisible();

  await pageB.goto("/chats");
  await pageB.getByRole("link", { name: new RegExp(`@${usernameA}`) }).click();
  await expect(pageB).toHaveURL(/\/chats\/\d+/);
  await expect(
    pageB.getByRole("link", { name: `@${usernameB}`, exact: true }),
  ).toBeVisible();
});
