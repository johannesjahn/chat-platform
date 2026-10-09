import { expect, test } from "./fixtures";

// Issue #315: the app was hard-locked to dark mode.

test("the theme follows the OS preference by default", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveClass(/\blight\b/);
  await expect(html).not.toHaveClass(/\bdark\b/);

  // Flipping the OS setting flips the open tab.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/\bdark\b/);
});

test("the header toggle overrides the OS and is remembered", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveClass(/\bdark\b/);

  // System → Light.
  await page.getByRole("button", { name: /^Theme: System/ }).click();
  await expect(html).toHaveClass(/\blight\b/);
  await expect(
    page.getByRole("button", { name: /^Theme: Light/ }),
  ).toBeVisible();

  // Still light after a reload, despite the OS asking for dark — and
  // already on the first paint, before the app has hydrated.
  await page.reload();
  await expect(html).toHaveClass(/\blight\b/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#f7f8fb",
  );
});

test("settings offers the theme, even signed out", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");
  const html = page.locator("html");
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();

  await theme.getByRole("radio", { name: "Dark" }).click();
  await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(html).toHaveClass(/\bdark\b/);

  // Back to following the OS.
  await theme.getByRole("radio", { name: "System" }).click();
  await expect(html).toHaveClass(/\blight\b/);
  await page.reload();
  await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(html).toHaveClass(/\blight\b/);
});
