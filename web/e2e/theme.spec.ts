import { expect, test } from "./fixtures";

// Issue #315: the app was hard-locked to dark mode.

test("the theme follows the OS preference by default", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveClass(/\blight\b/);
  await expect(html).not.toHaveClass(/\bdark\b/);
  // The app is interactive (so the first paint was the boot script's work,
  // and from here the app's own listener takes over). The toggle paints a
  // beat before React's effects subscribe that listener, so let a frame and
  // a task go by too — an OS switch inside that instant is what
  // `watch()`'s catch-up is for, but emulating one there races the
  // renderer's own media re-evaluation.
  await expect(
    page.getByRole("button", { name: /^Theme: System/ }),
  ).toBeVisible();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve)),
      ),
  );

  // Flipping the OS setting flips the open tab, browser chrome included.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#0b0d13",
  );
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
