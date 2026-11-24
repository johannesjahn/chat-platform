import { expect, test } from "./fixtures";

// Search within a conversation (issue #900): hits from that chat only, and
// picking one scrolls to it, paging back through the history to find it.

test("searching a chat from its details jumps to an old message", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const me = await signUp(page);
  const headers = { Authorization: `Bearer ${me.session.accessToken}` };
  const post = async (path: string, data: unknown) => {
    const response = await request.post(`${apiUrl}${path}`, { headers, data });
    expect(response.ok()).toBe(true);
    return (await response.json()) as { id: number };
  };
  const chatWith = async () =>
    (
      await post("/chats/direct", {
        userId: (await createUser()).session.user.id,
      })
    ).id;
  const chatId = await chatWith();
  const otherId = await chatWith();
  const say = (id: number, content: string) =>
    post(`/chats/${id}/messages`, { contentType: "text", content });
  await say(chatId, "the lighthouse code is 4821");
  await say(otherId, "a lighthouse elsewhere");
  for (let i = 0; i < 45; i++) await say(chatId, `filler ${i}`);

  await page.goto(`/chats/${chatId}`);
  const thread = page.getByRole("main");
  await expect(thread.getByText("filler 44")).toBeVisible();
  const details = page.getByRole("complementary", { name: "Chat details" });
  if (!(await details.isVisible()))
    await page.getByRole("button", { name: "Chat details" }).click();

  const box = details.getByRole("searchbox", { name: "Search in this chat" });
  await box.fill("lighthouse");
  const results = details.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await results.getByRole("button", { name: /4821/ }).click();
  await expect(
    thread.getByText("the lighthouse code is 4821"),
  ).toBeInViewport();

  await box.fill("nothing like this");
  await expect(details.getByText("No messages match.")).toBeVisible();
});
