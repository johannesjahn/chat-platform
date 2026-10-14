import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Issue #605: the feed, chat and post routes warm their queries in a loader
// (on link intent, or at the latest on navigation) with the same options
// their components read them with — so a page's requests start before its
// component mounts, and the component renders from them rather than
// fetching the same thing over again.
//
// Measured on client-side navigations: a full page load also connects the
// realtime socket, whose first connect deliberately refetches every
// event-driven query (see realtimeSocket.ts), loader-warmed or not.

// Every GET the page sends the backend, by path.
function countApiGets(page: Page, apiUrl: string) {
  const paths: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" || !request.url().startsWith(apiUrl)) return;
    paths.push(new URL(request.url()).pathname);
  });
  return (path: string) => paths.filter((p) => p === path).length;
}

test("hovering a link starts its page's requests, and following it doesn't repeat them", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const other = await createUser();
  const as = (user: typeof me) => ({
    Authorization: `Bearer ${user.session.accessToken}`,
  });

  const post = await request.post(`${apiUrl}/posts`, {
    headers: as(other),
    data: { contentType: "text", content: "A post worth warming" },
  });
  const { id: postId } = await post.json();
  const chat = await request.post(`${apiUrl}/chats/direct`, {
    headers: as(me),
    data: { userId: other.session.user.id },
  });
  const { id: chatId } = await chat.json();
  // Sent by `me`, so the chat opens read: marking it read refetches the
  // chat, which isn't what's being counted here.
  const message = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
    headers: as(me),
    data: { contentType: "text", content: "A message worth warming" },
  });
  expect(message.ok()).toBe(true);

  // Start somewhere without a loader, and let the socket connect.
  await page.goto(`/users/${other.session.user.id}`);
  await expect(page.getByText("A post worth warming")).toBeVisible();
  await page.waitForTimeout(1_000);

  const gets = countApiGets(page, apiUrl);
  // Long enough for a component's own (wrongly duplicated) fetch to show.
  const settle = () => page.waitForTimeout(750);
  const sidebar = page.getByRole("navigation", { name: "Main" });

  // Hovering a link is enough to start its page's requests...
  const openPost = page.getByRole("link", { name: "Open post" }).first();
  await openPost.hover();
  await expect.poll(() => gets(`/posts/${postId}`)).toBe(1);
  await expect.poll(() => gets(`/posts/${postId}/comments`)).toBe(1);
  // ...and following it doesn't send them again.
  await openPost.click();
  await expect(page).toHaveURL(`/posts/${postId}`);
  await expect(page.getByRole("main")).toContainText("A post worth warming");
  await settle();
  expect(gets(`/posts/${postId}`)).toBe(1);
  expect(gets(`/posts/${postId}/comments`)).toBe(1);

  const feed = sidebar.getByRole("link", { name: "Feed", exact: true });
  await feed.hover();
  await expect.poll(() => gets("/posts")).toBe(1);
  await feed.click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("A post worth warming")).toBeVisible();
  await settle();
  expect(gets("/posts")).toBe(1);

  await sidebar.getByRole("link", { name: /^Chats/ }).click();
  await expect(page).toHaveURL("/chats");
  const chatRow = page.getByRole("link", {
    name: new RegExp(`@${other.username}`),
  });
  await chatRow.hover();
  await expect.poll(() => gets(`/chats/${chatId}`)).toBe(1);
  await expect.poll(() => gets(`/chats/${chatId}/messages`)).toBe(1);
  await chatRow.click();
  await expect(page).toHaveURL(`/chats/${chatId}`);
  await expect(
    page.getByRole("main").getByText("A message worth warming"),
  ).toBeVisible();
  await settle();
  expect(gets(`/chats/${chatId}`)).toBe(1);
  expect(gets(`/chats/${chatId}/messages`)).toBe(1);
});
