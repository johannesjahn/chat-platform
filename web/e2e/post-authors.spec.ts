import { expect, test } from "./fixtures";

// Issue #750: posts and comments embed their author, so the feed and a post's
// thread label every byline from the payload itself — no `GET /users/:id` per
// author, and never a `user #N` placeholder while one is in flight.

test("the feed and a post's comments render bylines without per-author requests", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  const alice = await createUser();
  const bob = await createUser();
  const as = (user: typeof alice) => ({
    Authorization: `Bearer ${user.session.accessToken}`,
  });
  for (const [user, displayName] of [
    [alice, "Alice Byline"],
    [bob, "Bob Byline"],
  ] as const) {
    const profile = await request.put(`${apiUrl}/users/me`, {
      headers: as(user),
      data: { displayName, avatarUrl: null },
    });
    expect(profile.ok()).toBe(true);
  }
  const post = await request.post(`${apiUrl}/posts`, {
    headers: as(alice),
    data: { contentType: "text", content: "Alice's embedded post" },
  });
  const { id: postId } = await post.json();
  const bobsPost = await request.post(`${apiUrl}/posts`, {
    headers: as(bob),
    data: { contentType: "text", content: "Bob's embedded post" },
  });
  expect(bobsPost.ok()).toBe(true);
  const comment = await request.post(`${apiUrl}/posts/${postId}/comments`, {
    headers: as(bob),
    data: { content: "Bob's embedded comment" },
  });
  expect(comment.ok()).toBe(true);

  // Every `GET /users/<id>` the page sends — the per-author lookup this
  // replaced. (Hovering a name would still fetch its profile card, so the
  // test never rests the pointer on one.)
  const userLookups: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" || !req.url().startsWith(apiUrl)) return;
    const path = new URL(req.url()).pathname;
    if (/^\/users\/\d+$/.test(path)) userLookups.push(path);
  });

  await signUp(page);
  await page.goto("/");
  const main = page.getByRole("main");
  await expect(
    main.getByRole("article", { name: "Post by Alice Byline" }),
  ).toContainText(`@${alice.username}`);
  await expect(
    main.getByRole("article", { name: "Post by Bob Byline" }),
  ).toContainText("Bob's embedded post");
  await expect(main).not.toContainText("user #");

  await page.goto(`/posts/${postId}`);
  const thread = page.getByTestId("comment");
  await expect(thread).toContainText("Bob's embedded comment");
  await expect(thread).toContainText("Bob Byline");
  await expect(thread).toContainText(`@${bob.username}`);
  await expect(page.getByRole("main")).not.toContainText("user #");

  expect(userLookups).toEqual([]);
});
