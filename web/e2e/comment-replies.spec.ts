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
