import type { Locator, Page } from "@playwright/test";
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

// Loads `path` with nothing cached and waits until the app is up and quiet:
// `ready` is on screen and the realtime socket has connected. A fixed sleep
// isn't enough under a loaded dev server — the app may not even have mounted
// yet, and the socket's first-connect refetch would land among the requests
// counted.
async function openSettled(page: Page, path: string, ready: Locator) {
  // `signUp` already loaded the feed, and the persister may have stored it
  // — which would leave nothing for a hover to fetch. Dropped once, before
  // the app boots.
  await page.context().addInitScript(() => {
    try {
      if (sessionStorage.getItem("e2e-query-cache-dropped")) return;
      sessionStorage.setItem("e2e-query-cache-dropped", "1");
      for (const key of Object.keys(localStorage))
        if (key.startsWith("chat-platform-query-cache"))
          localStorage.removeItem(key);
    } catch {
      // about:blank has no storage; the real page load does it.
    }
  });
  const socketUp = new Promise<void>((resolve) =>
    page.on("websocket", (ws) => ws.once("framereceived", () => resolve())),
  );
  await page.goto(path);
  await expect(ready).toBeVisible();
  await socketUp;
  // Let the refetches that connect set off come back.
  await page.waitForTimeout(500);
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

  // Start on a page these tests don't measure.
  await openSettled(
    page,
    `/users/${other.session.user.id}`,
    page.getByText("A post worth warming"),
  );

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
  // The URL changes as the navigation starts; hover once it has landed.
  await expect(page.getByText("Select a conversation")).toBeVisible();
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

test("a conversation opened from its warmed window still pages back through older messages", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  // The loader fetches the newest page, and the conversation adopts it —
  // cursors included — rather than fetching again. Paging back has to
  // continue from that window: without its cursors, "load earlier" would
  // just re-fetch the newest page and the oldest messages never arrive.
  const me = await signUp(page);
  const other = await createUser();
  const auth = { Authorization: `Bearer ${me.session.accessToken}` };
  const chat = await request.post(`${apiUrl}/chats/direct`, {
    headers: auth,
    data: { userId: other.session.user.id },
  });
  const { id: chatId } = await chat.json();
  // More than one page (`MESSAGES_PAGE_SIZE`, 30), sent by `me` so the chat
  // opens read.
  for (let i = 0; i < 45; i++) {
    const sent = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
      headers: auth,
      data: { contentType: "text", content: `Paged message ${i}` },
    });
    expect(sent.ok()).toBe(true);
  }

  await openSettled(
    page,
    `/users/${other.session.user.id}`,
    page.getByRole("main").getByText(`@${other.username}`).first(),
  );
  const messageFetches: URL[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (
      req.method() === "GET" &&
      req.url().startsWith(apiUrl) &&
      url.pathname === `/chats/${chatId}/messages`
    )
      messageFetches.push(url);
  });

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^Chats/ })
    .click();
  await page
    .getByRole("link", { name: new RegExp(`@${other.username}`) })
    .click();
  await expect(page).toHaveURL(`/chats/${chatId}`);
  const thread = page.getByRole("main");
  await expect(thread.getByText("Paged message 44")).toBeVisible();
  await expect(
    thread.getByText("Paged message 0", { exact: true }),
  ).toHaveCount(0);
  await page.waitForTimeout(750);
  // One fetch: the loader's newest page, adopted on mount.
  expect(messageFetches).toHaveLength(1);
  expect(messageFetches[0]?.searchParams.has("before")).toBe(false);

  // Scrolling to the top pages back from the adopted window's oldest message.
  await page
    .getByTestId("chat-scroll")
    .evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(
    thread.getByText("Paged message 0", { exact: true }),
  ).toBeVisible();
  expect(messageFetches.some((url) => url.searchParams.has("before"))).toBe(
    true,
  );
});

test("the notifications inbox renders from its loader without fetching again", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const other = await createUser();
  const post = await request.post(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${me.session.accessToken}` },
    data: { contentType: "text", content: "Comment on this" },
  });
  const { id: postId } = await post.json();
  const comment = await request.post(`${apiUrl}/posts/${postId}/comments`, {
    headers: { Authorization: `Bearer ${other.session.accessToken}` },
    data: { content: "A comment that notifies" },
  });
  expect(comment.ok()).toBe(true);

  // A page with nothing focused, so the shortcut keys aren't typed into a
  // field (`/users` autofocuses its search).
  await openSettled(
    page,
    `/users/${other.session.user.id}`,
    page.getByRole("main").getByText(`@${other.username}`).first(),
  );
  const gets = countApiGets(page, apiUrl);

  // `g` then `n` navigates straight to the inbox (no link to hover), so the
  // loader runs on the navigation itself.
  await page.keyboard.press("g");
  await page.keyboard.press("n");
  await expect(page).toHaveURL("/notifications");
  await expect(
    page.getByRole("main").getByText("commented on your post"),
  ).toBeVisible();
  await page.waitForTimeout(750);
  expect(gets("/notifications")).toBe(1);
});
