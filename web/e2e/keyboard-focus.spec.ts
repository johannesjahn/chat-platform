import { expect, test } from "./fixtures";

// Issue #497: the header's links showed next to no focus indicator when
// tabbed to, and there was no way to skip past the header.

test("a skip link is the first tab stop and lands in the page", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Chats" })).toBeVisible();
  // The nav renders before the route's own component, so wait for the
  // skip link's target too.
  await expect(page.locator("main")).toBeVisible();

  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  // Hidden until focused, then actually on screen.
  const box = await skip.boundingBox();
  expect(box!.width).toBeGreaterThan(40);
  expect(box!.height).toBeGreaterThan(20);

  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();

  // The next Tab continues inside the page, not back in the header.
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest("main")),
  ).toBe(true);
});

test("header links show an opaque focus ring", async ({ page }) => {
  await page.goto("/");
  const chats = page.getByRole("link", { name: "Chats" });
  await expect(chats).toBeVisible();

  // Skip link, brand, then Chats.
  for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
  await expect(chats).toBeFocused();

  // The ring is a box-shadow in the full `--ring` color (it used to be at
  // half opacity), spread past a 2px gap. Polled: it transitions in.
  const ring = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--ring"),
  );
  await expect
    .poll(() => chats.evaluate((el) => getComputedStyle(el).boxShadow))
    .toContain(`${ring.trim()} 0px 0px 0px 4px`);
});
