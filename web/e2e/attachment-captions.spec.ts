import { expect, test } from "./fixtures";
import { makeSolidPng } from "./helpers";

// Captions on attachments (issue #765): text typed next to a file is posted
// with it as its caption, instead of being dropped.

const PNG = makeSolidPng(48, 32, [180, 120, 40]);

test("the inline composer posts typed text and an attached image together", async ({
  page,
  signUp,
}) => {
  await signUp(page);

  const composer = page.getByRole("textbox", { name: "Write a post" });
  await composer.click();
  await composer.fill("Look what I baked https://example.com/bread");

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach" }).click();
  await (
    await chooser
  ).setFiles({ name: "bread.png", mimeType: "image/png", buffer: PNG });

  // The text stays put while the file uploads, and nothing warns that it'll
  // be thrown away.
  await expect(composer).toHaveValue(
    "Look what I baked https://example.com/bread",
  );
  await expect(page.getByText("Remove it to post your text")).toHaveCount(0);

  const post = page.getByRole("button", { name: "Post", exact: true });
  await expect(post).toBeEnabled();
  await post.click();
  await expect(composer).toHaveValue("");

  // Both render on the card: the caption (linkified like any text) and the
  // image.
  const card = page
    .getByRole("article")
    .filter({ hasText: "Look what I baked" });
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("img", { name: "bread.png" })).toBeVisible();
  await expect(
    card.getByRole("link", { name: "https://example.com/bread" }),
  ).toBeVisible();

  // And it's what the server stored, not just the optimistic view.
  await page.reload();
  const reloaded = page
    .getByRole("article")
    .filter({ hasText: "Look what I baked" });
  await expect(reloaded.getByRole("img", { name: "bread.png" })).toBeVisible();
});

test("a chat message keeps what was typed as the attachment's caption", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const bob = await createUser();
  const chat = await request.post(`${apiUrl}/chats/direct`, {
    headers: { Authorization: `Bearer ${me.session.accessToken}` },
    data: { userId: bob.session.user.id },
  });
  expect(chat.ok()).toBe(true);
  const { id } = (await chat.json()) as { id: number };

  await page.goto(`/chats/${id}`);
  const thread = page.getByRole("main");
  await thread
    .getByRole("textbox", { name: /Write a message/ })
    .fill("Fresh out of the oven");

  // Paste-free attach: the composer's own file input.
  await thread
    .locator('input[type="file"]')
    .setInputFiles({ name: "bread.png", mimeType: "image/png", buffer: PNG });
  const caption = thread.getByRole("textbox", { name: "Caption" });
  await expect(caption).toHaveValue("Fresh out of the oven");

  const send = thread.getByRole("button", { name: "Send message" });
  await expect(send).toBeEnabled();
  await send.click();

  const bubble = thread
    .locator("[data-message-id]")
    .filter({ hasText: "Fresh out of the oven" });
  await expect(bubble).toHaveCount(1);
  await expect(bubble.getByRole("img", { name: "bread.png" })).toBeVisible();
});
