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

// Issue #526: the pickers and lists where you choose *who* to message, add,
// promote or remove showed only the display name (and /users the internal
// `#id`), so a borrowed display name couldn't be told apart there either.
test("user pickers and lists show the @username next to a display name", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const viewer = await signUp(page);
  const carol = await createUser();
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const displayName = "Carol Lookalike";
  const handle = `@${carol.username}`;

  const renamed = await request.put(`${apiUrl}/users/me`, {
    headers: as(carol.session.accessToken),
    data: { displayName, avatarUrl: null },
  });
  expect(renamed.ok()).toBe(true);
  const word = `wren${carol.username.slice(-6)}`;
  const post = await request.post(`${apiUrl}/posts`, {
    headers: as(carol.session.accessToken),
    data: { contentType: "text", content: `Spotted a ${word} today` },
  });
  expect(post.ok()).toBe(true);
  const group = await request.post(`${apiUrl}/chats/group`, {
    headers: as(viewer.session.accessToken),
    data: { title: "Handles", participantIds: [carol.session.user.id] },
  });
  expect(group.ok()).toBe(true);
  const { id: chatId } = await group.json();

  // /users: the handle, not `#id`.
  await page.goto("/users");
  await page.getByPlaceholder("Search users…").fill(carol.username);
  const userRow = page.getByRole("link").filter({ hasText: displayName });
  await expect(userRow).toContainText(handle);
  await expect(userRow).not.toContainText(`#${carol.session.user.id}`);

  // New chat picker.
  await page.goto("/chats/new");
  await page.getByPlaceholder("Search users…").fill(carol.username);
  await expect(
    page.getByRole("button").filter({ hasText: displayName }),
  ).toContainText(handle);

  // Group chat -> Manage -> Members, including who the remove button names.
  await page.goto(`/chats/${chatId}`);
  await page.getByRole("button", { name: "Manage group" }).click();
  await expect(
    page.getByRole("button", { name: `Remove ${displayName} ${handle}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: displayName }).first(),
  ).toContainText(handle);

  // Global search -> Posts: the author line.
  await page.goto(`/search?q=${word}`);
  await expect(
    page.getByRole("link").filter({ hasText: `Spotted a ${word}` }),
  ).toContainText(handle);

  // Issue #546: the game lobby invite picker.
  await page.goto("/games/typing");
  await page.getByRole("button", { name: "New lobby" }).click();
  await expect(page.getByText("Waiting room")).toBeVisible();
  await page.getByRole("button", { name: "Invite players" }).click();
  await page.getByLabel("Search users to invite").fill(carol.username);
  await expect(
    page.getByRole("listitem").filter({ hasText: displayName }),
  ).toContainText(handle);
});
