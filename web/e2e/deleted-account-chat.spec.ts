import { expect, test } from "./fixtures";

// A direct chat with someone who deletes their account (issue #895) stays
// readable but takes no new messages, and says why instead of showing a
// one-person "Direct chat".

test("a direct chat turns read-only, live, once the other account is deleted", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const partner = await createUser();
  const auth = {
    Authorization: `Bearer ${partner.session.accessToken}`,
  };
  const chatResponse = await request.post(`${apiUrl}/chats/direct`, {
    headers: auth,
    data: { userId: me.session.user.id },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = (await chatResponse.json()) as { id: number };
  const sent = await request.post(`${apiUrl}/chats/${chat.id}/messages`, {
    headers: auth,
    data: { contentType: "text", content: "Goodbye for now" },
  });
  expect(sent.ok()).toBe(true);

  await page.goto(`/chats/${chat.id}`);
  const thread = page.getByRole("main");
  await expect(thread.getByText("Goodbye for now")).toBeVisible();
  await expect(thread.getByPlaceholder("Message…")).toBeVisible();

  const deleted = await request.delete(`${apiUrl}/users/me`, {
    headers: auth,
    data: { password: partner.password },
  });
  expect(deleted.ok()).toBe(true);

  // The deletion's `chat_updated` brings it in without a reload.
  const bar = thread.getByRole("region", { name: "Account deleted" });
  await expect(bar).toContainText("This account was deleted.");
  await expect(thread.getByPlaceholder("Message…")).toHaveCount(0);
  await expect(thread.getByText("Deleted account").first()).toBeVisible();
  await expect(thread.getByText("1 participant")).toHaveCount(0);

  const list = page.getByRole("complementary", { name: "Conversations" });
  await expect(list.getByText("Deleted account")).toBeVisible();
});
