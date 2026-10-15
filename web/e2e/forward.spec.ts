import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures";
import { makeSolidPng } from "./helpers";

// Forwarding chat messages (issue #601).

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

test("forwarding a text and an image to two chats labels both copies and confirms with a toast", async ({
  page,
  apiUrl,
  request,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const bob = await createUser();
  const carol = await createUser();
  const myToken = me.session.accessToken;
  const bobToken = bob.session.accessToken;

  // Bob sends me a text and a photo; I have a chat with Carol and a group
  // with her to forward them into.
  const withBob = await api<{ id: number }>(
    request,
    `${apiUrl}/chats/direct`,
    myToken,
    { userId: bob.session.user.id },
  );
  const withCarol = await api<{ id: number }>(
    request,
    `${apiUrl}/chats/direct`,
    myToken,
    { userId: carol.session.user.id },
  );
  await api(request, `${apiUrl}/chats/group`, myToken, {
    title: "Forward club",
    participantIds: [carol.session.user.id],
  });
  await api(request, `${apiUrl}/chats/${withBob.id}/messages`, bobToken, {
    contentType: "text",
    content: "Pass this along please",
  });
  const upload = await request.post(`${apiUrl}/attachments`, {
    headers: { Authorization: `Bearer ${bobToken}` },
    multipart: {
      file: {
        name: "photo.png",
        mimeType: "image/png",
        buffer: makeSolidPng(24, 16, [30, 160, 90]),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const attachment = (await upload.json()) as { id: number };
  await api(request, `${apiUrl}/chats/${withBob.id}/messages`, bobToken, {
    contentType: "attachment",
    content: "photo.png",
    attachmentId: attachment.id,
  });

  await page.goto(`/chats/${withBob.id}`);
  const thread = page.getByRole("main");

  const forwardTo = async (bubbleText: string | null) => {
    const bubbles = thread.locator("[data-message-id]");
    const bubble = bubbleText
      ? bubbles.filter({ hasText: bubbleText })
      : bubbles.filter({ has: page.locator("img") });
    await bubble.hover();
    await bubble.getByRole("button", { name: "Forward message" }).click();

    const dialog = page.getByRole("dialog", { name: "Forward message" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox", { name: `@${carol.username}` }).click();
    await dialog.getByRole("searchbox", { name: "Search chats" }).fill("club");
    await dialog.getByRole("checkbox", { name: "Forward club" }).click();
    await expect(dialog.getByText("2 of 10 selected")).toBeVisible();
    await dialog.getByRole("button", { name: "Forward", exact: true }).click();

    await expect(dialog).toHaveCount(0);
    const toast = page.getByTestId("toast").last();
    await expect(toast).toContainText("Forwarded to 2 chats");
    await toast.getByRole("button", { name: "Dismiss" }).click();
  };

  await forwardTo("Pass this along please");
  await forwardTo(null);

  // Both copies sit in each target, credited to Bob, not to me.
  for (const path of [`/chats/${withCarol.id}`, null]) {
    if (path) await page.goto(path);
    else {
      await page.goto("/chats");
      await page.getByRole("link", { name: /Forward club/ }).click();
    }
    const labels = thread.getByTestId("forwarded-label");
    await expect(labels).toHaveCount(2);
    for (const label of await labels.all())
      await expect(label).toHaveText(`Forwarded from ${bob.username}`);
    await expect(thread.getByText("Pass this along please")).toBeVisible();
    await expect(
      thread.locator("[data-message-id]").filter({ has: page.locator("img") }),
    ).toHaveCount(1);
  }
});
