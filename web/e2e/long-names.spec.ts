import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// A name is one unbroken word as far as line-breaking goes, so a long one
// used to push whatever sat beside it out of its box: the profile's Message
// button off the card on a phone, a comment's time off the screen, a group
// chat bubble past the thread's edge. These run on every layout (`@layout`).

// The longest display name the API takes, as a single word.
const LONG_NAME =
  "Wolfeschlegelsteinhausenbergerdorffvoralternwarengewissenhaftsch";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectInside(inner: Locator, outer: Locator) {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a!.x).toBeGreaterThanOrEqual(b!.x - 1);
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + b!.width + 1);
}

async function rename(
  request: APIRequestContext,
  apiUrl: string,
  accessToken: string,
) {
  const response = await request.put(`${apiUrl}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { displayName: LONG_NAME, avatarUrl: null },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: number };
}

test(
  "a long name stays inside the profile card, post and comment",
  { tag: "@layout" },
  async ({ page, apiUrl, request, createUser, signUp }) => {
    const other = await createUser();
    const { id: otherId } = await rename(
      request,
      apiUrl,
      other.session.accessToken,
    );
    const headers = { Authorization: `Bearer ${other.session.accessToken}` };
    const post = await request.post(`${apiUrl}/posts`, {
      headers,
      data: { contentType: "text", content: "A post with a long byline" },
    });
    const { id: postId } = await post.json();
    const comment = await request.post(`${apiUrl}/posts/${postId}/comments`, {
      headers,
      data: { content: "And a comment" },
    });
    expect(comment.ok()).toBe(true);
    await signUp(page);

    await page.goto(`/users/${otherId}`);
    const message = page.getByRole("button", { name: "Message" });
    await expect(message).toBeVisible();
    await expectInside(message, page.locator('[data-slot="card"]').first());
    await expectNoHorizontalScroll(page);

    await page.goto(`/posts/${postId}`);
    const time = page
      .getByRole("main")
      .locator("[data-comment-id]")
      .getByText("just now");
    await expect(time).toBeVisible();
    await expectInside(time, page.getByRole("main"));
    await expectNoHorizontalScroll(page);
  },
);

test(
  "a long sender name stays inside a group chat bubble",
  { tag: "@layout" },
  async ({ page, apiUrl, request, createUser, signUp }) => {
    const me = await signUp(page);
    const other = await createUser();
    const { id: otherId } = await rename(
      request,
      apiUrl,
      other.session.accessToken,
    );
    const group = await request.post(`${apiUrl}/chats/group`, {
      headers: { Authorization: `Bearer ${me.session.accessToken}` },
      data: { title: "Long names", participantIds: [otherId] },
    });
    const { id: chatId } = await group.json();
    const sent = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
      headers: { Authorization: `Bearer ${other.session.accessToken}` },
      data: { contentType: "text", content: "Hello there" },
    });
    expect(sent.ok()).toBe(true);

    await page.goto(`/chats/${chatId}`);
    const bubble = page
      .getByRole("main")
      .locator("[data-message-id]")
      .filter({ hasText: "Hello there" });
    await expect(bubble).toBeVisible();
    await expectInside(
      bubble.getByRole("link", { name: new RegExp(LONG_NAME) }).last(),
      page.getByRole("main"),
    );
    await expectNoHorizontalScroll(page);
  },
);
