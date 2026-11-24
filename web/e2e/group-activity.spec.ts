import { expect, test } from "./fixtures";

// Group activity in the timeline (issue #900), live.

test("group changes appear in the open conversation", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const friend = await createUser();
  const added = await createUser();
  const headers = { Authorization: `Bearer ${me.session.accessToken}` };
  const post = async (path: string, data: unknown) => {
    const response = await request.post(`${apiUrl}${path}`, { headers, data });
    expect(response.ok()).toBe(true);
    return (await response.json()) as { id: number };
  };
  const { id } = await post("/chats/group", {
    title: "Trip",
    participantIds: [friend.session.user.id],
  });
  await page.goto(`/chats/${id}`);
  const thread = page.getByTestId("chat-scroll");
  await expect(thread.getByText(/No messages yet/)).toBeVisible();

  await post(`/chats/${id}/participants`, {
    participantIds: [added.session.user.id],
  });
  const rows = thread.getByTestId("chat-event");
  await expect(rows).toHaveText([/^You added /]);

  await post(`/chats/${id}/messages`, { body: "hi" });
  await expect(thread.getByText("hi", { exact: true })).toBeVisible();
  const left = await request.post(`${apiUrl}/chats/${id}/leave`, {
    headers: { Authorization: `Bearer ${added.session.accessToken}` },
  });
  expect(left.ok()).toBe(true);
  await expect(rows).toHaveText([/^You added /, / left$/]);

  await page.reload();
  await expect(rows).toHaveText([/^You added /, / left$/]);
});

test("activity that loads after the messages doesn't remount them", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const friend = await createUser();
  const added = await createUser();
  const headers = { Authorization: `Bearer ${me.session.accessToken}` };
  const post = async (path: string, data: unknown) => {
    const response = await request.post(`${apiUrl}${path}`, { headers, data });
    expect(response.ok()).toBe(true);
    return (await response.json()) as { id: number };
  };
  const { id } = await post("/chats/group", {
    title: "Trip",
    participantIds: [friend.session.user.id],
  });
  await post(`/chats/${id}/participants`, {
    participantIds: [added.session.user.id],
  });
  await post(`/chats/${id}/messages`, {
    body: "hello",
  });

  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/chats\/\d+\/events$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`/chats/${id}`);
  const thread = page.getByTestId("chat-scroll");
  const bubble = thread.getByText("hello", { exact: true });
  await expect(bubble).toBeVisible();
  const element = await bubble.elementHandle();

  release();
  await expect(thread.getByTestId("chat-event")).toHaveCount(1);
  expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
});
