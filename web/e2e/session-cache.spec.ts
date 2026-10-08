import { expect, test } from "./fixtures";
import { logOut, persistedQueryCache } from "./helpers";

// Issue #478: the persisted query cache used to outlive a logout, and query
// keys aren't scoped per user — so the next account to sign in on the same
// browser could open the previous one's chats straight from the cache, and
// the view kept showing them even after the server answered 403.
test("logging out wipes cached chats, and the next account on the same browser can't read them", async ({
  page,
  signUp,
  createUser,
}) => {
  await signUp(page);
  const other = await createUser();
  const nextUser = await createUser();

  await page.goto("/chats/new");
  await page.getByRole("button", { name: "Direct message" }).click();
  await page.fill("#user-search", other.username);
  await page.getByRole("button", { name: `@${other.username}` }).click();
  await expect(page).toHaveURL(/\/chats\/\d+/);
  const chatUrl = new URL(page.url()).pathname;

  const secret = "Private message that must not outlive the session";
  await page.fill("textarea", secret);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main").getByText(secret)).toBeVisible();
  // The persister throttles writes (1s) — wait until the message really is
  // in the snapshot, so the assertions below prove it gets removed.
  await expect.poll(() => persistedQueryCache(page)).toContain(secret);

  await logOut(page);
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Log in" }),
  ).toBeVisible();
  await expect.poll(() => persistedQueryCache(page)).not.toContain(secret);

  await page.goto("/login");
  await page.fill("#username", nextUser.username);
  await page.fill("#password", nextUser.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");

  await page.goto(chatUrl);
  await expect(page.getByText("Chat not found")).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);
});
