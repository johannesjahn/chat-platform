import { expect, test } from "./fixtures";

// Issue #479: replies used to be fetched only once the viewer clicked
// "Reply" (which also opened a composer), so existing replies were
// invisible — even though the post's comment count included them.
test("existing replies are announced with a count and expand without opening a composer", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  await signUp(page);
  const author = await createUser();
  const commenter = await createUser();
  const as = (user: typeof author) => ({
    Authorization: `Bearer ${user.session.accessToken}`,
  });

  const post = await request.post(`${apiUrl}/posts`, {
    headers: as(author),
    data: { contentType: "text", content: "A post with a thread" },
  });
  const { id: postId } = await post.json();
  const comment = await request.post(`${apiUrl}/posts/${postId}/comments`, {
    headers: as(commenter),
    data: { content: "Top-level comment" },
  });
  const { id: commentId } = await comment.json();
  for (const content of ["First reply", "Second reply"]) {
    const reply = await request.post(
      `${apiUrl}/comments/${commentId}/replies`,
      {
        headers: as(author),
        data: { content },
      },
    );
    expect(reply.ok()).toBe(true);
  }

  await page.goto(`/posts/${postId}`);
  await expect(page.getByText("Top-level comment")).toBeVisible();
  await expect(page.getByText("First reply")).toHaveCount(0);

  await page.getByRole("button", { name: "View 2 replies" }).click();
  await expect(page.getByText("First reply")).toBeVisible();
  await expect(page.getByText("Second reply")).toBeVisible();
  await expect(page.getByPlaceholder(/^Reply to/)).toHaveCount(0);

  await page.getByRole("button", { name: "Hide replies" }).click();
  await expect(page.getByText("First reply")).toHaveCount(0);
});

// Issue #544: the "Hide replies" toggle only renders while there are
// replies, so a panel left open when they dropped to zero stayed open and
// empty with nothing left to close it. It must close along with the toggle.
test("the replies panel closes once its last reply is deleted", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  await signUp(page);
  const author = await createUser();
  const as = { Authorization: `Bearer ${author.session.accessToken}` };

  const post = await request.post(`${apiUrl}/posts`, {
    headers: as,
    data: { contentType: "text", content: "A post with a short thread" },
  });
  const { id: postId } = await post.json();
  const comment = await request.post(`${apiUrl}/posts/${postId}/comments`, {
    headers: as,
    data: { content: "Lonely comment" },
  });
  const { id: commentId } = await comment.json();

  await page.goto(`/posts/${postId}`);
  const thread = page.locator(`[data-comment-id="${commentId}"]`);
  await expect(thread.getByText("Lonely comment")).toBeVisible();

  // Replying to a comment with no replies yet shows the new reply expanded.
  await thread.getByRole("button", { name: "Reply" }).click();
  await thread.getByPlaceholder(/^Reply to/).fill("Only reply");
  // The composer's submit button, below the action row's "Reply".
  await thread.getByRole("button", { name: "Reply" }).last().click();
  const reply = thread.getByTestId("comment").filter({ hasText: "Only reply" });
  await expect(reply).toBeVisible();
  await expect(
    thread.getByRole("button", { name: "Hide replies" }),
  ).toBeVisible();

  await reply.getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Delete this comment?",
  });
  await dialog.getByRole("button", { name: "Delete comment" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(reply).toHaveCount(0);
  await expect(thread.getByRole("button", { name: /replies/ })).toHaveCount(0);
  // No panel left behind, open or closing.
  await expect(thread.locator(".collapse-panel")).toHaveCount(0);
});
