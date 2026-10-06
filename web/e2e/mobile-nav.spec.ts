import { expect, test } from "./fixtures";

// Issue #494: on a phone the nav wrapped onto three rows and, pinned, took
// about a third of the screen. It's now one row, with search and the rest of
// the links behind a menu button.
test.use({ viewport: { width: 390, height: 844 } });

test("the phone nav is a single row with the rest behind a menu", async ({
  page,
  signUp,
}) => {
  const { username } = await signUp(page);
  await page.goto("/");

  const nav = page.locator("[data-app-nav]");
  const box = await nav.boundingBox();
  expect(box!.height).toBeLessThan(80);

  // Chats and the bell stay in the bar; the rest waits behind the menu.
  await expect(nav.getByRole("link", { name: "Chats" })).toBeVisible();
  await expect(
    nav.getByRole("link", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await expect(nav.getByRole("link", { name: "Games" })).toHaveCount(0);
  await expect(nav.getByRole("searchbox")).toHaveCount(0);

  const menu = nav.getByRole("button", { name: "Menu" });
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("link", { name: `@${username}` })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Log out" })).toBeVisible();

  // Following a link closes the menu behind it.
  await nav.getByRole("link", { name: "Games" }).click();
  await expect(page).toHaveURL("/games");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("link", { name: "Games" })).toHaveCount(0);

  // Search lives in the menu, and submitting it lands on the results page.
  await menu.click();
  await nav.getByRole("searchbox", { name: "Search" }).fill("peregrine");
  await nav.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect(page).toHaveURL(/\/search\?q=peregrine/);
  await expect(menu).toHaveAttribute("aria-expanded", "false");
});

// Issue #545: the menu closes on navigation by watching the URL, so an item
// that leaves the URL unchanged — the current page's own link, or logging
// out on `/` (which navigates to `/`) — used to leave it open.
test("the phone menu closes even when an item doesn't change the URL", async ({
  page,
  signUp,
}) => {
  await signUp(page);
  await page.goto("/users");

  const nav = page.locator("[data-app-nav]");
  const menu = nav.getByRole("button", { name: "Menu" });
  // Signed-in only, so it's there once the app has taken over the page.
  await expect(
    nav.getByRole("link", { name: "Notifications", exact: true }),
  ).toBeVisible();

  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await nav.getByRole("link", { name: "Users" }).click();
  await expect(page).toHaveURL("/users");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("link", { name: "Users" })).toHaveCount(0);

  // Back to the feed in-app (the brand link) rather than a reload.
  await nav.getByRole("link", { name: "Chat Platform" }).click();
  await expect(page).toHaveURL("/");
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await nav.getByRole("button", { name: "Log out" }).click();
  await expect(nav.getByRole("link", { name: "Log in" })).toBeVisible();
  await expect(page).toHaveURL("/");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("link", { name: "Register" })).toHaveCount(0);
});
