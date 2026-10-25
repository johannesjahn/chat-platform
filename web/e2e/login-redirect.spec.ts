import { googleSubFor } from "../../src/GoogleTestSigner";
import { expect, test } from "./fixtures";
import { signInWithGoogle } from "./google";
import { randomUsername } from "./helpers";

// Issue #481: logging in (or signing up) from a "Log in to …" prompt used
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
  await signInWithGoogle(page, invitee.sub);

  await expect(page).toHaveURL(`/chats/join/${code}`);
  await expect(page.getByText("You've been invited to a chat")).toBeVisible();
});

test("signing up from a post's prompt returns to the post, through the username step", async ({
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
  // A Google account with no user yet: the username step keeps the
  // original target.
  const username = randomUsername();
  await signInWithGoogle(page, googleSubFor(username));
  await expect(page).toHaveURL(/\/register\?/);
  // The route swap runs through a view transition, so the outgoing login
  // page can still be the one a fill lands in — retry until the username
  // form actually holds the value.
  const create = page.getByRole("button", { name: "Create account" });
  await expect(async () => {
    await page.fill("#username", username);
    await expect(create).toBeEnabled({ timeout: 1000 });
  }).toPass();
  await create.click();

  await expect(page).toHaveURL(`/posts/${postId}`);
  await expect(page.getByText("Worth signing up for")).toBeVisible();
});

test("a redirect pointing off-site is ignored", async ({
  page,
  createUser,
}) => {
  const user = await createUser();
  await page.goto("/login?redirect=%2F%2Fexample.com%2Fphish");
  await signInWithGoogle(page, user.sub);
  await expect(page).toHaveURL("/");
});
