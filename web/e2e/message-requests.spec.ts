import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures";

// Message requests (issue #785): a group from someone you've never chatted
// with waits in "Message requests" until you accept or decline it.

async function api<T>(
  request: APIRequestContext,
  url: string,
  token: string,
  data: unknown,
): Promise<T> {
  const response = await request.post(url, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as T;
}

test("a stranger's group waits in Message requests until it's accepted", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const stranger = await createUser();
  const token = stranger.session.accessToken;
  const group = await api<{ id: number }>(
    request,
    `${apiUrl}/chats/group`,
    token,
    { title: "Totally legit deals", participantIds: [me.session.user.id] },
  );
  await api(request, `${apiUrl}/chats/${group.id}/messages`, token, {
    contentType: "text",
    content: "Click this link",
  });

  await page.goto("/chats");
  const list = page.getByRole("complementary", { name: "Conversations" });
  await expect(list.getByText("No conversations yet")).toBeVisible();
  await expect(list.getByText("Totally legit deals")).toHaveCount(0);
  await list.getByRole("link", { name: /Message requests/ }).click();

  await expect(page).toHaveURL("/chats/requests");
  const requests = page.getByRole("main");
  await requests.getByRole("link", { name: /Totally legit deals/ }).click();

  await expect(page).toHaveURL(`/chats/${group.id}`);
  const thread = page.getByRole("main");
  await expect(thread.getByText("Click this link")).toBeVisible();
  const bar = thread.getByRole("region", { name: "Message request" });
  await expect(
    bar.getByText(`@${stranger.username} added you to this group.`),
  ).toBeVisible();
  // Read-only until accepted.
  await expect(thread.getByPlaceholder("Message…")).toHaveCount(0);

  await bar.getByRole("button", { name: "Accept" }).click();
  await expect(bar).toHaveCount(0);
  await expect(thread.getByPlaceholder("Message…")).toBeVisible();
  await expect(
    list.getByRole("link", { name: /Totally legit deals/ }),
  ).toBeVisible();
  await expect(
    list.getByRole("link", { name: /Message requests/ }),
  ).toHaveCount(0);
});

test("declining a request leaves the group and can block whoever added you", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const stranger = await createUser();
  const group = await api<{ id: number }>(
    request,
    `${apiUrl}/chats/group`,
    stranger.session.accessToken,
    { title: "Spam central", participantIds: [me.session.user.id] },
  );

  await page.goto(`/chats/${group.id}`);
  const bar = page
    .getByRole("main")
    .getByRole("region", { name: "Message request" });
  await bar
    .getByRole("button", { name: `Decline and block @${stranger.username}` })
    .click();

  await expect(page).toHaveURL("/chats/requests");
  await expect(
    page.getByRole("main").getByText("No message requests"),
  ).toBeVisible();

  const blocks = await request.get(`${apiUrl}/users/me/blocks`, {
    headers: { Authorization: `Bearer ${me.session.accessToken}` },
  });
  const blocked = (await blocks.json()) as { user: { id: number } }[];
  expect(blocked.map((b) => b.user.id)).toEqual([stranger.session.user.id]);
});
