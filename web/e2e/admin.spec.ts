import { expect, test } from "./fixtures";

// The admin dashboard's numbers are covered by src/admin.test.ts. These cover
// the half that only exists in the browser: that a regular account is never
// shown the entrance, that reaching the route anyway lands on the refusal
// rather than a broken page or a spinner that never resolves — and that an
// admin, made with the `create-admin` CLI and signed in through the admin
// password form, does get the dashboard.

test("a regular user gets no Admin nav entry", async ({ page, signUp }) => {
  await signUp(page);

  await expect(page.getByRole("link", { name: "Users" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
});

test("a regular user visiting /admin is told it's admins only", async ({
  page,
  signUp,
}) => {
  await signUp(page);
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

test.describe("an admin password account", () => {
  const admin = { username: "e2e_root", password: "root-pw-1234" };
  test.use({ admins: [admin] });

  test("signs in through the admin form and opens the dashboard", async ({
    page,
  }) => {
    await page.goto("/login?method=password&redirect=%2Fadmin");
    await page.fill("#username", admin.username);
    await page.fill("#password", admin.password);
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL("/admin");
    await expect(
      page.getByRole("heading", { name: "Admin dashboard" }),
    ).toBeVisible();
    await expect(page.getByText("Totals")).toBeVisible();
  });
});
