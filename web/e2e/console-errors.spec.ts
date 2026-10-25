import { expect, test } from "./fixtures";

// Issue #618: the `consoleErrors` fixture fails a test at teardown when a
// page logs an error nobody allowed. `test.fail()` flips that teardown
// failure into the expected outcome, so these pass only while it does.

test("a console.error fails the test", async ({ page }) => {
  test.fail();
  await page.goto("/login?method=password");
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await page.evaluate(() => console.error("e2e: an unexpected error"));
});

test("an unhandled rejection fails the test", async ({ page }) => {
  test.fail();
  await page.goto("/login?method=password");
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await page.evaluate(() => {
    void Promise.reject(new Error("e2e: an unhandled rejection"));
  });
  // `pageerror` arrives asynchronously; give it a beat before teardown.
  await page.waitForTimeout(100);
});

test("an error the test allowed doesn't fail it", async ({
  page,
  allowConsoleErrors,
}) => {
  allowConsoleErrors(/^e2e: an expected error$/);
  await page.goto("/login?method=password");
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await page.evaluate(() => console.error("e2e: an expected error"));
});
