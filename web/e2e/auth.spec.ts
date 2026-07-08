import { expect, test } from "./fixtures";
import { randomUsername } from "./helpers";

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
