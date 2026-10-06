import { expect, test } from "./fixtures";

// Issue #496: unknown URLs used to show TanStack's bare "Not Found" text.

test("an unknown URL shows the 404 page with a way back to the feed", async ({
  page,
}) => {
  await page.goto("/does-not-exist");
  const main = page.getByRole("main");
  await expect(main.getByText("Page not found")).toBeVisible();
  // Issue #528: it carries its own title and `<h1>` like every other page.
  await expect(page).toHaveTitle("Page not found · Chat Platform");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Page not found",
  );
  // The app shell still renders around it.
  await expect(page.locator("[data-app-nav]")).toBeVisible();

  await main.getByRole("link", { name: "Go to feed" }).click();
  await expect(page).toHaveURL("/");
  await expect(page).toHaveTitle("Feed · Chat Platform");
});

// Issue #502: an unknown game slug used to be a dead end.
test("an unknown game links back to the arcade", async ({ page }) => {
  await page.goto("/games/no-such-game");
  const main = page.getByRole("main");
  await expect(main.getByText("Game not found")).toBeVisible();

  await main.getByRole("link", { name: "Back to the arcade" }).click();
  await expect(page).toHaveURL("/games");
});
