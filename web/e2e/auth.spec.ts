import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

// A unique username per run so repeated runs never collide on the (unique)
// username column. base64url keeps it to URL-safe, schema-valid characters.
function randomUsername(): string {
  return `u_${randomBytes(9).toString("base64url")}`;
}

test("registers a new user and sees the user list after login", async ({
  page,
}) => {
  const username = randomUsername();
  const password = "playwright-pw-123";

  await page.goto("/register");
  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Register" }).click();

  // Registration auto-logs-in and redirects to the home page.
  await expect(page).toHaveURL("/");
  await expect(page.getByText(`Welcome back, ${username}`)).toBeVisible();

  // The user list is a protected endpoint — it should now load (the bearer
  // token is attached) and include the freshly registered user. Scope to the
  // list so we don't also match the username shown in the nav bar.
  await expect(page.getByRole("list").getByText(`@${username}`)).toBeVisible();
});
