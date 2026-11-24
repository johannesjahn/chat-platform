import { expect, test } from "./fixtures";

// Muting, archiving and pinning a chat (issue #900).

test("pin, archive and mute a chat from its details", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const me = await signUp(page);
  const headers = { Authorization: `Bearer ${me.session.accessToken}` };
  const older = await createUser();
  const newer = await createUser();
  const chatWith = async (user: typeof older) => {
    const response = await request.post(`${apiUrl}/chats/direct`, {
      headers,
      data: { userId: user.session.user.id },
    });
    const { id } = (await response.json()) as { id: number };
    const send = async (content: string) => {
      const sent = await request.post(`${apiUrl}/chats/${id}/messages`, {
        headers: { Authorization: `Bearer ${user.session.accessToken}` },
        data: { body: content },
      });
      expect(sent.ok()).toBe(true);
    };
    return { id, send };
  };
  const olderChat = await chatWith(older);
  await olderChat.send("from the older chat");
  const newerChat = await chatWith(newer);
  await newerChat.send("from the newer chat");

  await page.goto(`/chats/${olderChat.id}`);
  const list = page.getByRole("complementary", { name: "Conversations" });
  const rows = list.getByRole("listitem");
  await expect(rows.first()).toContainText("from the newer chat");
  const details = page.getByRole("complementary", { name: "Chat details" });
  if (!(await details.isVisible()))
    await page.getByRole("button", { name: "Chat details" }).click();

  await details.getByRole("button", { name: "Pin chat" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    details.getByRole("button", { name: "Unpin chat" }),
  ).toBeFocused();
  await expect(rows.first()).toContainText("from the older chat");
  await expect(rows.first().getByLabel("Pinned chat")).toBeVisible();

  await details.getByRole("button", { name: "Archive chat" }).click();
  await expect(rows).toHaveCount(1);
  await list.getByRole("link", { name: /Archived/ }).click();
  await expect(page).toHaveURL("/chats/archived");
  // The row, not the same text in the conversation being left.
  await expect(
    page.getByRole("main").getByRole("link", { name: /from the older chat/ }),
  ).toBeVisible();

  // A new message brings it back.
  await olderChat.send("are you there?");
  await expect(rows.first()).toContainText("are you there?");
  await expect(list.getByRole("link", { name: /Archived/ })).toHaveCount(0);

  // Muted: its own badge, but nothing more in the tab's title.
  await rows
    .first()
    .getByRole("link", { name: /are you there/ })
    .click();
  await expect(page).toHaveURL(`/chats/${olderChat.id}`);
  await details
    .getByRole("group", { name: "Mute chat" })
    .getByRole("button", { name: "Always" })
    .click();
  await expect(
    details.getByRole("button", { name: "Unmute chat" }),
  ).toBeVisible();
  await page.goto(`/chats/${newerChat.id}`);
  await expect(page).toHaveTitle(/^(?!\()/);
  await olderChat.send("muted message");
  const mutedRow = rows.filter({ hasText: "muted message" });
  await expect(mutedRow.getByTestId("unread-badge")).toHaveText("1");
  await expect(mutedRow.getByLabel("Muted")).toBeVisible();
  await expect(page).toHaveTitle(/^(?!\()/);
});
