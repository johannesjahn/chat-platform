import { expect, test } from "./fixtures";

// Issue #496: unknown URLs used to show TanStack's bare "Not Found" text.

test("an unknown URL shows the 404 page with a way back to the feed", async ({
  page,
}) => {
  await page.goto("/does-not-exist");
  const main = page.getByRole("main");
  await expect(main.getByText("Page not found")).toBeVisible();
  // The app shell still renders around it.
  await expect(page.locator("[data-app-nav]")).toBeVisible();

  await main.getByRole("link", { name: "Go to feed" }).click();
  await expect(page).toHaveURL("/");
});

// Issue #502: an unknown game slug used to be a dead end.
test("an unknown game links back to the arcade", async ({ page }) => {
  await page.goto("/games/no-such-game");
  const main = page.getByRole("main");
  await expect(main.getByText("Game not found")).toBeVisible();

  await main.getByRole("link", { name: "Back to the arcade" }).click();
  await expect(page).toHaveURL("/games");
});

// Issue #529: a deleted/missing post used to show a raw error banner
// ("Could not load post: Post 99999 not found") under a heading of "Post".
test("a missing post shows a not-found state", async ({ page, signUp }) => {
  await signUp(page);
  await page.goto("/posts/99999");
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { level: 1, name: "Post not found" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Post not found · Chat Platform");
  await expect(main.getByText("Could not load post")).toHaveCount(0);

  await main.getByRole("link", { name: "Back to feed" }).click();
  await expect(page).toHaveURL("/");

  // An id that doesn't even parse is just as missing.
  await page.goto("/posts/not-a-number");
  await expect(
    main.getByRole("heading", { level: 1, name: "Post not found" }),
  ).toBeVisible();
});
