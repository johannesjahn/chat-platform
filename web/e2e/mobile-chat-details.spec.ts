import type { APIRequestContext } from "@playwright/test";
import { expect, test, type TestUser } from "./fixtures";
import { makeSolidPng } from "./helpers";

// Issue #907: starred messages and shared media lived only in the `xl`+
// details panel, so a phone could star a message but never see it, and a
// direct chat had no details at all. Below `xl` the same contents open as a
// full-screen sheet from the conversation header. The full-page forms got a
// way back too, for an installed PWA with no browser back button. Each test
// sets its own viewport, so none is `@layout`.
test.use({ viewport: { width: 390, height: 844 } });

async function api(
  request: APIRequestContext,
  url: string,
  user: TestUser,
  data?: unknown,
) {
  const response = await request.post(url, {
    headers: { Authorization: `Bearer ${user.session.accessToken}` },
    data,
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: number };
}

// A chat with a starred text message and a shared photo, both from `me`.
async function seedChat(
  request: APIRequestContext,
  apiUrl: string,
  me: TestUser,
  chatId: number,
) {
  const { id: starredId } = await api(
    request,
    `${apiUrl}/chats/${chatId}/messages`,
    me,
    { body: "Remember the meeting room code 4821" },
  );
  await api(
    request,
    `${apiUrl}/chats/${chatId}/messages/${starredId}/star`,
    me,
  );
  const upload = await request.post(`${apiUrl}/attachments`, {
    headers: { Authorization: `Bearer ${me.session.accessToken}` },
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
  await api(request, `${apiUrl}/chats/${chatId}/messages`, me, {
    body: "",
    attachmentId: attachment.id,
  });
  await api(request, `${apiUrl}/chats/${chatId}/messages`, me, {
    body: "The newest message",
  });
}

test("a direct chat's details sheet shows starred messages and shared media", async ({
  page,
  request,
  apiUrl,
  signUp,
  createUser,
}) => {
  const me = await signUp(page);
  const bob = await createUser();
  const { id: chatId } = await api(request, `${apiUrl}/chats/direct`, me, {
    userId: bob.session.user.id,
  });
  await seedChat(request, apiUrl, me, chatId);

  await page.goto(`/chats/${chatId}`);
  await expect(
    page.getByRole("main").getByText("The newest message"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chat details" }).click();

  const sheet = page.getByRole("dialog", { name: "Chat details" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(bob.username).first()).toBeVisible();
  await expect(sheet.getByRole("link", { name: "View profile" })).toBeVisible();
  await expect(sheet.getByText("Starred · 1")).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: /meeting room code 4821/ }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Show photo.png in chat" }),
  ).toBeVisible();

  // Picking a starred message closes the sheet onto the thread.
  await sheet.getByRole("button", { name: /meeting room code 4821/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect(
    page.getByRole("main").getByText("Remember the meeting room code 4821"),
  ).toBeInViewport();

  // Escape closes it too.
  await page.getByRole("button", { name: "Chat details" }).click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("a group's details sheet has starred messages, shared media and its settings", async ({
  page,
  request,
  apiUrl,
  signUp,
  createUser,
}) => {
  const me = await signUp(page);
  const bob = await createUser();
  const { id: chatId } = await api(request, `${apiUrl}/chats/group`, me, {
    title: "Phone crew",
    participantIds: [bob.session.user.id],
  });
  await seedChat(request, apiUrl, me, chatId);

  await page.goto(`/chats/${chatId}`);
  // "Manage" still opens the group settings; details sit beside it.
  await expect(
    page.getByRole("button", { name: "Manage group" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chat details" }).click();

  const sheet = page.getByRole("dialog", { name: "Chat details" });
  await expect(
    sheet.getByRole("heading", { name: "Group details" }),
  ).toBeVisible();
  await expect(sheet.getByText("Starred · 1")).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Show photo.png in chat" }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Rename chat" }),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "Close chat details" }).click();
  await expect(sheet).toHaveCount(0);
});

test("new post, edit post and new chat each have a way back", async ({
  page,
  request,
  apiUrl,
  signUp,
}) => {
  const me = await signUp(page);
  const { id: postId } = await api(request, `${apiUrl}/posts`, me, {
    body: "A post to edit",
  });

  // A direct load has no history to step back through, so each falls back
  // to a link (from inside the app it steps back instead — the same
  // `BackButton` as a post's page, covered by post-back.spec.ts).
  await page.goto("/posts/new");
  await page.getByRole("link", { name: "Back to feed" }).click();
  await expect(page).toHaveURL("/");

  await page.goto(`/posts/${postId}/edit`);
  await page.getByRole("link", { name: "Back to post" }).click();
  await expect(page).toHaveURL(`/posts/${postId}`);

  await page.goto("/chats/new");
  await page.getByRole("link", { name: "Back to chats" }).click();
  await expect(page).toHaveURL("/chats");
});
