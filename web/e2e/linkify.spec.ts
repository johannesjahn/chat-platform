import { expect, test } from "./fixtures";
import { registerViaUi } from "./helpers";

// Auto-linking bare `http(s)` URLs in post/comment/message text (issue
// #319): a shared link becomes clickable — opened in a new tab, with
// `rel="noopener noreferrer"` — instead of sitting there as inert text.

test("a URL in a post, its comment, and a chat message all render as clickable links", async ({
  page,
  browser,
  injectApiUrl,
}) => {
  await registerViaUi(page);

  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill(
    "#content",
    "Check out https://example.com/path?q=1 for details.",
  );
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");

  const post = page.getByRole("article").first();
  await expect(post).toContainText(
    "Check out https://example.com/path?q=1 for details.",
  );
  // Trailing sentence punctuation isn't part of the URL.
  const postLink = post.getByRole("link", {
    name: "https://example.com/path?q=1",
    exact: true,
  });
  await expect(postLink).toBeVisible();
  await expect(postLink).toHaveAttribute(
    "href",
    "https://example.com/path?q=1",
  );
  await expect(postLink).toHaveAttribute("target", "_blank");
  await expect(postLink).toHaveAttribute("rel", "noopener noreferrer");

  await post.getByRole("button", { name: "Comments" }).click();
  await page.fill("textarea", "See (https://example.org) as well");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(
    page.getByText("See (https://example.org) as well"),
  ).toBeVisible();

  const comment = page.getByTestId("comment").filter({
    hasText: "See (https://example.org) as well",
  });
  // The wrapping parens aren't part of the URL either.
  await expect(
    comment.getByRole("link", { name: "https://example.org", exact: true }),
  ).toHaveAttribute("href", "https://example.org");

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const { username: usernameB } = await registerViaUi(pageB);

  await page.goto("/chats/new");
  await page.getByRole("button", { name: "Direct message" }).click();
  await page.fill("#user-search", usernameB);
  await page.getByRole("button", { name: `@${usernameB}` }).click();
  await expect(page).toHaveURL(/\/chats\/\d+/);

  await page.fill("textarea", "Join here: https://chat.example.com/room/42");
  await page.keyboard.press("Enter");

  const messageLink = page.getByRole("link", {
    name: "https://chat.example.com/room/42",
    exact: true,
  });
  await expect(messageLink).toBeVisible();
  await expect(messageLink).toHaveAttribute(
    "href",
    "https://chat.example.com/room/42",
  );
  await expect(messageLink).toHaveAttribute("target", "_blank");
});
