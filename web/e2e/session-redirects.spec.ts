import { expect, test } from "./fixtures";
import { logOut } from "./helpers";

// Issue #499: a signed-in user could still open the auth pages, and logging
// out left them on whatever page they were on, half signed out.

test("a signed-in user opening /login or /register is sent to the feed", async ({
  page,
  signUp,
}) => {
  const { username } = await signUp(page);

  await page.goto("/login");
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByText(`@${username}`),
  ).toBeVisible();

  await page.goto("/register");
  await expect(page).toHaveURL("/");
  await expect(page.locator("#password")).toHaveCount(0);
});

test("a signed-in user opening /login with a redirect is sent to its target", async ({
  page,
  signUp,
}) => {
  await signUp(page);

  await page.goto(`/login?redirect=${encodeURIComponent("/settings")}`);
  await expect(page).toHaveURL("/settings");
});

test("logging out from settings lands on the feed", async ({
  page,
  signUp,
}) => {
  await signUp(page);

  await page.goto("/settings");
  await logOut(page);

  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Log in" }),
  ).toBeVisible();

  // Signed out again, the auth pages are reachable as before.
  await page.goto("/login");
  await expect(page).toHaveURL("/login");
  await expect(page.locator("#password")).toBeVisible();
});
