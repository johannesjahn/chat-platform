import { expect, test } from "./fixtures";
import { registerViaUi } from "./helpers";

// The admin dashboard's *happy* path is covered by src/admin.test.ts, which
// can promote a user in the database directly; e2e drives the real backend in
// its own process, so there's no way from here to mint an admin. What these
// tests do cover is the half that only exists in the browser: that a regular
// account is never shown the entrance, and that reaching the route anyway
// lands on the refusal rather than a broken page or a spinner that never
// resolves.

test("a regular user gets no Admin nav entry", async ({ page }) => {
  await registerViaUi(page);

  await expect(page.getByRole("link", { name: "Users" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
});

test("a regular user visiting /admin is told it's admins only", async ({
  page,
}) => {
  await registerViaUi(page);
  await page.goto("/admin");

  await expect(
    page.getByRole("heading", { name: "Admin dashboard" }),
  ).toBeVisible();
  await expect(page.getByText("Admins only")).toBeVisible();
  // The refusal is the whole page — no statistics leak past the gate, and the
  // query is never issued in the first place (`enabled: isAdmin`).
  await expect(page.getByText("Totals")).toHaveCount(0);
  await expect(page.getByText("Health")).toHaveCount(0);
});

test("a signed-out visitor visiting /admin is prompted to log in", async ({
  page,
}) => {
  await page.goto("/admin");

  await expect(
    page.getByText("Log in to view the admin dashboard"),
  ).toBeVisible();
});
