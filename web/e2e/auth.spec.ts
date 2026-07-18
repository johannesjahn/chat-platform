import { expect, test } from "./fixtures";
import { randomUsername, registerViaUi } from "./helpers";

test("registers a new user and sees the user list after login", async ({
  page,
}) => {
  const username = randomUsername();
  const password = "playwright-pw-123";

  await page.goto("/register");
  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Register" }).click();

  // Registration auto-logs-in and redirects to the home page (the feed).
  await expect(page).toHaveURL("/");
  await expect(page.getByText(`@${username}`)).toBeVisible();

  // User search lives on its own page and is a protected endpoint — it
  // should now load (the bearer token is attached) and, once searched,
  // include the freshly registered user. Scope to the list so we don't also
  // match the username shown in the nav bar.
  await page.goto("/users");
  await page.getByPlaceholder("Search users…").fill(username);
  await expect(page.getByRole("list").getByText(`@${username}`)).toBeVisible();
});

test("changes password from settings and can log back in with the new one", async ({
  page,
}) => {
  const { username, password } = await registerViaUi(page);
  const newPassword = "playwright-new-pw-456";

  await page.goto("/settings");
  await page.fill("#current-password", password);
  await page.fill("#new-password", newPassword);
  await page.fill("#confirm-password", newPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed.")).toBeVisible();

  // The session stays logged in on this device, under the new password.
  await page.goto("/users");
  await expect(page.getByText(`@${username}`)).toBeVisible();

  // Logging out and back in with the new password proves it actually took
  // effect server-side (and that the old one no longer works).
  await page.getByRole("button", { name: "Log out" }).click();
  await page.goto("/login");
  await page.fill("#username", username);
  await page.fill("#password", newPassword);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText(`@${username}`)).toBeVisible();
});

test("setting a display name replaces the username in the nav, but the profile page still shows both", async ({
  page,
}) => {
  const { username } = await registerViaUi(page);
  const displayName = "Ada Lovelace";

  // The settings page no longer offers a way to change the username itself —
  // it's shown read-only.
  await page.goto("/settings");
  await expect(page.locator("#username")).toHaveCount(0);
  await expect(page.getByText(`@${username}`)).toBeVisible();

  await page.fill("#display-name", displayName);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile updated.")).toBeVisible();

  // Everywhere but the profile page (and the settings page's own read-only
  // username field, checked above), the display name now takes over from
  // the raw username — starting with the feed, once navigated there.
  await page.goto("/");
  const navLink = page.locator("nav, header").getByText(displayName).first();
  await expect(navLink).toBeVisible();
  await expect(page.getByText(`@${username}`)).not.toBeVisible();

  // The profile page is the one place that still surfaces the actual
  // username, alongside the display name.
  await navLink.click();
  await expect(page).toHaveURL(/\/users\/\d+/);
  await expect(page.getByText(`@${username}`)).toBeVisible();
});
