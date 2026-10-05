import { expect, test } from "./fixtures";

// Issue #498: every page used to be titled just "Chat Platform", and many
// had no `<h1>` for screen readers to land on.

test("signed-out pages carry their own title and heading", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveTitle("Log in · Chat Platform");
  await expect(
    page.getByRole("heading", { level: 1, name: "Welcome back" }),
  ).toBeVisible();

  await page.goto("/register");
  await expect(page).toHaveTitle("Create an account · Chat Platform");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Create an account",
  );
});

test("titles follow navigation and use loaded data", async ({
  page,
  request,
  apiUrl,
  signUp,
}) => {
  const { username, session } = await signUp(page);
  await expect(page).toHaveTitle("Feed · Chat Platform");

  const response = await request.post(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    data: { contentType: "text", content: "Weekend plans\n\nHiking, mostly." },
  });
  expect(response.ok()).toBe(true);
  const post = (await response.json()) as { id: number };

  await page.goto(`/posts/${post.id}`);
  await expect(page).toHaveTitle(
    "Weekend plans Hiking, mostly. · Chat Platform",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Post by @${username}`,
  );

  await page.goto(`/users/${session.user.id}`);
  await expect(page).toHaveTitle(`@${username} · Chat Platform`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `@${username}`,
  );

  // Client-side navigation away replaces the data-derived title rather than
  // leaving it behind.
  await page.getByRole("link", { name: "Settings" }).first().click();
  await expect(page).toHaveTitle("Settings · Chat Platform");
  await page.goBack();
  await expect(page).toHaveTitle(`@${username} · Chat Platform`);
});
