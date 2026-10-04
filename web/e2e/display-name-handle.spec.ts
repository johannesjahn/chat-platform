import { expect, test } from "./fixtures";

// Issue #482: display names are free-form and not unique, and used to be
// shown *instead of* the username — so anyone could set theirs to another
// user's handle and be indistinguishable from them. The real `@username`
// now rides along wherever a display name identifies an author.
test("a display name copying someone else's handle still shows the impersonator's own @username", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const viewer = await signUp(page);
  const victim = await createUser();
  const impostor = await createUser();
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  const renamed = await request.put(`${apiUrl}/users/me`, {
    headers: as(impostor.session.accessToken),
    data: { displayName: victim.username, avatarUrl: null },
  });
  expect(renamed.ok()).toBe(true);

  const group = await request.post(`${apiUrl}/chats/group`, {
    headers: as(viewer.session.accessToken),
    data: {
      title: "Who's who",
      participantIds: [victim.session.user.id, impostor.session.user.id],
    },
  });
  expect(group.ok()).toBe(true);
  const { id: chatId } = await group.json();
  for (const [user, content] of [
    [victim, "the real one"],
    [impostor, "trust me, it's me"],
  ] as const) {
    const sent = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
      headers: as(user.session.accessToken),
      data: { contentType: "text", content },
    });
    expect(sent.ok()).toBe(true);
  }
  const post = await request.post(`${apiUrl}/posts`, {
    headers: as(impostor.session.accessToken),
    data: { contentType: "text", content: "Posted under a borrowed name" },
  });
  expect(post.ok()).toBe(true);

  await page.goto(`/chats/${chatId}`);
  await expect(page.getByText("trust me, it's me")).toBeVisible();
  // The impostor's label carries their real handle...
  await expect(page.getByText(`@${impostor.username}`)).toBeVisible();
  // ...while the victim, who has no display name, is labelled by theirs.
  await expect(page.getByText(`@${victim.username}`)).toBeVisible();

  await page.goto(`/posts/${(await post.json()).id}`);
  await expect(page.getByText(`@${impostor.username}`)).toBeVisible();
});
