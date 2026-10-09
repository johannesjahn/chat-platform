import { expect, test } from "./fixtures";

// In-app notifications (issue #317): the header bell lights up live when
// something happens to you, and the inbox links back to it. On a desktop the
// bell opens a popover of the newest ones (issue #554), with "See all" for
// the full inbox. At `xl` — the suite's 1280px — the inbox opens a
// notification in a preview pane rather than navigating (issue #564).

test("an @mention lights up the bell live and the inbox links to the post", async ({
  browser,
  injectApiUrl,
  signUp,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const alice = await signUp(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const bob = await signUp(pageB);

  await expect(
    pageA.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible();

  await pageB.goto("/posts/new");
  await pageB.getByRole("button", { name: "Text" }).click();
  await pageB.fill("#content", `Hey @${alice.username}, look at this`);
  await pageB.getByRole("button", { name: "Post" }).click();
  await expect(pageB).toHaveURL("/");

  // No reload on Alice's side — the realtime push updates the badge.
  const bell = pageA.getByRole("button", {
    name: "Notifications (1 unread)",
  });
  await expect(bell).toBeVisible();
  await bell.click();
  const popover = pageA.getByRole("dialog", { name: "Notifications" });
  await expect(
    popover.getByRole("link", {
      name: new RegExp(`${bob.username}.*mentioned you in a post`),
    }),
  ).toContainText("look at this");
  await popover.getByRole("link", { name: "See all notifications" }).click();
  await expect(pageA).toHaveURL("/notifications");
  await expect(popover).toHaveCount(0);

  const row = pageA.getByRole("main").getByRole("link", {
    name: new RegExp(`${bob.username}.*mentioned you in a post`),
  });
  await expect(row).toContainText("look at this");
  // A click previews the post beside the list, and still marks it read.
  await row.click();
  await expect(pageA).toHaveURL("/notifications");
  const pane = pageA.getByRole("complementary", { name: "Preview: Post" });
  await expect(pane).toContainText(`Hey @${alice.username}, look at this`);
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(
    pageA.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible();

  await pane.getByRole("link", { name: "Open" }).click();
  await expect(pageA).toHaveURL(/\/posts\/\d+/);
});

test("the inbox preview highlights a reply in its thread; ↑/↓ and Enter work from the keyboard", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const alice = await signUp(page);
  const bob = await createUser();
  const as = (user: typeof bob) => ({
    Authorization: `Bearer ${user.session.accessToken}`,
  });

  // Alice posts and comments; Bob comments on the post, then replies to her
  // comment — two notifications for Alice, the reply newest.
  const post = await request.post(`${apiUrl}/posts`, {
    headers: as(alice),
    data: { contentType: "text", content: "A post to talk about" },
  });
  const { id: postId } = await post.json();
  const own = await request.post(`${apiUrl}/posts/${postId}/comments`, {
    headers: as(alice),
    data: { content: "Alice's own comment" },
  });
  const { id: ownId } = await own.json();
  const comment = await request.post(`${apiUrl}/posts/${postId}/comments`, {
    headers: as(bob),
    data: { content: "Bob's comment" },
  });
  expect(comment.ok()).toBe(true);
  const reply = await request.post(`${apiUrl}/comments/${ownId}/replies`, {
    headers: as(bob),
    data: { content: "Bob's reply" },
  });
  expect(reply.ok()).toBe(true);

  await page.goto("/notifications");
  const main = page.getByRole("main");
  const replyRow = main.getByRole("link", {
    name: new RegExp(`${bob.username}.*replied to your comment`),
  });
  const commentRow = main.getByRole("link", {
    name: new RegExp(`${bob.username}.*commented on your post`),
  });
  await expect(commentRow).toBeVisible();

  // The reply shows under its parent, below the post.
  await replyRow.click();
  const pane = page.getByRole("complementary", { name: "Preview: Comment" });
  await expect(pane).toContainText("A post to talk about");
  const thread = pane.getByTestId("comment");
  await expect(thread).toHaveCount(2);
  await expect(thread.first()).toContainText("Alice's own comment");
  await expect(thread.last()).toContainText("Bob's reply");

  // ↓ moves to the next row, and the pane follows it.
  await replyRow.focus();
  await page.keyboard.press("ArrowDown");
  await expect(commentRow).toBeFocused();
  await expect(commentRow).toHaveAttribute("aria-current", "true");
  await expect(thread).toHaveCount(1);
  await expect(thread).toContainText("Bob's comment");

  // Enter opens the target.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/posts/${postId}`);
});

test("below xl a notification still navigates on click", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const alice = await signUp(page);
  const bob = await createUser();
  const post = await request.post(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${bob.session.accessToken}` },
    data: { contentType: "text", content: `Ping @${alice.username}` },
  });
  const { id: postId } = await post.json();

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/notifications");
  await page
    .getByRole("main")
    .getByRole("link", { name: /mentioned you in a post/ })
    .click();
  await expect(page).toHaveURL(`/posts/${postId}`);
});

test("a game invite lands in the inbox and opens the lobby", async ({
  browser,
  injectApiUrl,
  signUp,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const alice = await signUp(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const bob = await signUp(pageB);

  await pageA.goto("/games/typing");
  await pageA.getByRole("button", { name: "New lobby" }).click();
  await expect(pageA.getByText("Waiting room")).toBeVisible();
  const lobbyPath = new URL(pageA.url()).pathname;

  await pageA.getByRole("button", { name: "Invite players" }).click();
  await pageA.getByLabel("Search users to invite").fill(bob.username);
  await pageA.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(pageA.getByRole("button", { name: "Invited" })).toBeVisible();

  // Straight from the bell's popover this time.
  await pageB.getByRole("button", { name: "Notifications (1 unread)" }).click();
  await pageB
    .getByRole("dialog", { name: "Notifications" })
    .getByRole("link", {
      name: new RegExp(`${alice.username}.*invited you to play Type Race`),
    })
    .click();
  await expect(pageB).toHaveURL(lobbyPath);
  await expect(
    pageB.getByRole("button", { name: "Join the race" }),
  ).toBeVisible();
});
