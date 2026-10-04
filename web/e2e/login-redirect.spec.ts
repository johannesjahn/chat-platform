import { expect, test } from "./fixtures";
import { randomUsername } from "./helpers";

// Issue #481: logging in (or registering) from a "Log in to …" prompt used
// to always land on the feed, losing the link the visitor came for.

test("logging in from an invite link's prompt returns to the invite", async ({
  page,
  apiUrl,
  request,
  createUser,
}) => {
  const owner = await createUser();
  const member = await createUser();
  const invitee = await createUser();
  const auth = { Authorization: `Bearer ${owner.session.accessToken}` };

  const group = await request.post(`${apiUrl}/chats/group`, {
    headers: auth,
    data: { title: "Redirect squad", participantIds: [member.session.user.id] },
  });
  expect(group.ok()).toBe(true);
  const { id: chatId } = await group.json();
  const invite = await request.post(`${apiUrl}/chats/${chatId}/invites`, {
    headers: auth,
    data: {},
  });
  expect(invite.ok()).toBe(true);
  const { code } = await invite.json();

  await page.goto(`/chats/join/${code}`);
  await page.getByRole("main").getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/login\?/);
  await page.fill("#username", invitee.username);
  await page.fill("#password", invitee.password);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(`/chats/join/${code}`);
  await expect(page.getByText("You've been invited to a chat")).toBeVisible();
});

test("registering from a post's prompt returns to the post, even after hopping via the login page", async ({
  page,
  apiUrl,
  request,
  createUser,
}) => {
  const author = await createUser();
  const created = await request.post(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${author.session.accessToken}` },
    data: { contentType: "text", content: "Worth signing up for" },
  });
  expect(created.ok()).toBe(true);
  const { id: postId } = await created.json();

  await page.goto(`/posts/${postId}`);
  await page.getByRole("main").getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/login\?/);
  // Changing their mind on the login page keeps the original target.
  await page.getByRole("main").getByRole("link", { name: "Register" }).click();
  await expect(page).toHaveURL(/\/register\?/);
  // The route swap runs through a view transition, so the outgoing login
  // form's fields can still be the ones a fill lands in — retry until the
  // register form actually holds the values.
  const username = randomUsername();
  const register = page.getByRole("button", { name: "Register" });
  await expect(async () => {
    await page.fill("#username", username);
    await page.fill("#password", "playwright-pw-123");
    await expect(register).toBeEnabled({ timeout: 1000 });
  }).toPass();
  await register.click();

  await expect(page).toHaveURL(`/posts/${postId}`);
  await expect(page.getByText("Worth signing up for")).toBeVisible();
});

test("a redirect pointing off-site is ignored", async ({
  page,
  createUser,
}) => {
  const user = await createUser();
  await page.goto("/login?redirect=%2F%2Fexample.com%2Fphish");
  await page.fill("#username", user.username);
  await page.fill("#password", user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
});
