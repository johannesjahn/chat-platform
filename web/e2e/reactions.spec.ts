import { expect, test } from "./fixtures";
import { registerViaUi } from "./helpers";

test("adding and removing a reaction on a post updates the pill through the real API", async ({
  page,
}) => {
  await registerViaUi(page);
  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill("#content", "React to this post");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");

  const card = page.getByRole("article", { name: /^Post by / });
  await card.getByRole("button", { name: "Add a reaction" }).click();
  await page.getByRole("button", { name: "React with 👍" }).click();

  const pill = card.getByRole("button", { name: "Remove 👍 reaction" });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText("👍1");

  await pill.click();
  // Count drops back to zero, so the pill disappears entirely rather than
  // flipping to an "Add" state.
  await expect(
    card.getByRole("button", { name: "Remove 👍 reaction" }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Add 👍 reaction" }),
  ).toHaveCount(0);
});

test("a failed post reaction shows a visible error instead of silently doing nothing (issue #233)", async ({
  page,
  apiUrl,
}) => {
  await registerViaUi(page);
  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill("#content", "Reacting to this will fail");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");

  const card = page.getByRole("article", { name: /^Post by / });

  // Simulate the mutation being rejected server-side (e.g. the per-user
  // engagement rate limiter, or any other 4xx) rather than a raw network
  // failure — this is the case the two `toggleReaction` implementations
  // used to swallow entirely.
  await page.route(`${apiUrl}/posts/*/reactions`, (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ message: "Too many reactions, slow down" }),
    }),
  );

  await card.getByRole("button", { name: "Add a reaction" }).click();
  await page.getByRole("button", { name: "React with 👍" }).click();

  await expect(card.getByText("Too many reactions, slow down")).toBeVisible();
  // No pill was optimistically added for a mutation that never succeeded.
  await expect(
    card.getByRole("button", { name: "Remove 👍 reaction" }),
  ).toHaveCount(0);
});

test("a failed comment reaction shows a visible error instead of silently doing nothing (issue #233)", async ({
  page,
  apiUrl,
}) => {
  // A taller viewport keeps the comment's reaction trigger (and the fixed-
  // position emoji popover it opens, positioned just below it) fully
  // on-screen without Playwright needing to scroll mid-interaction — a
  // scroll while the popover is open closes it (see ReactionPicker's
  // "close on scroll" listener), which would otherwise race the click.
  await page.setViewportSize({ width: 1280, height: 1600 });
  await registerViaUi(page);
  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill("#content", "Comment reactions can fail too");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");

  const card = page.getByRole("article", { name: /^Post by / });
  await card.getByRole("button", { name: "Comments" }).click();
  await page.fill("textarea", "A comment to react to");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("A comment to react to")).toBeVisible();

  await page.route(`${apiUrl}/comments/*/reactions`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "Internal error reacting" }),
    }),
  );

  // Both the post and its one comment render a `ReactionPicker` — scope to
  // the comment itself (via its `data-testid`) so this doesn't accidentally
  // exercise the post's own reaction picker instead.
  const comment = page.getByTestId("comment").filter({
    hasText: "A comment to react to",
  });
  await comment.getByRole("button", { name: "Add a reaction" }).click();
  await page.getByRole("button", { name: "React with 😂" }).click();

  await expect(comment.getByText("Internal error reacting")).toBeVisible();
  await expect(
    comment.getByRole("button", { name: "Remove 😂 reaction" }),
  ).toHaveCount(0);
});
