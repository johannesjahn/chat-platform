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
