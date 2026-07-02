import { expect, test } from "@playwright/test";
import { registerViaUi } from "./helpers";

// The e2e webServer boots the backend directly on this port (see
// playwright.config.ts) — posts are seeded straight against the API to keep
// the infinite-scroll test fast and deterministic instead of clicking
// through the "new post" UI eight times.
const API_URL = "http://localhost:3000";

// The feed endpoint returns every post from every user (it isn't scoped to
// the current user), and all tests here share one real backend/db instance.
// Running them concurrently would let one test's seeded posts shift another
// test's exact-count assertions (e.g. the infinite-scroll batch counts), so
// force this file to run serially instead of relying on `fullyParallel`.
test.describe.configure({ mode: "serial" });

test("creating a post shows it in the feed, and infinite scroll loads more posts in batches of 5 then 3", async ({
  page,
  request,
}) => {
  await registerViaUi(page);

  // Create the first post through the actual "New post" page.
  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill("#content", "My first post from the UI");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("My first post from the UI")).toBeVisible();

  // Seed 7 more posts directly against the API — 8 total is enough to
  // exercise two infinite-scroll batches (5 up front, 3 more on scroll).
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  for (let i = 0; i < 7; i++) {
    const response = await request.post(`${API_URL}/posts`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      data: { contentType: "text", content: `Seeded post ${i}` },
    });
    expect(response.ok()).toBe(true);
  }

  await page.reload();

  const articles = page.getByRole("article");
  await expect(articles).toHaveCount(5);

  // Scroll to the bottom to trigger the next infinite-scroll batch.
  await page.getByTestId("feed-sentinel").scrollIntoViewIfNeeded();
  await expect(articles).toHaveCount(8);

  // All 8 posts are loaded — no more batches left to fetch.
  await expect(page.getByText("You're all caught up.")).toBeVisible();
});

test("edit is only available to a post's author, both in the UI and when navigating directly", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const { username: usernameA } = await registerViaUi(pageA);

  await pageA.goto("/posts/new");
  await pageA.fill("#content", "Only the author should be able to edit this");
  await pageA.getByRole("button", { name: "Post" }).click();
  await expect(pageA).toHaveURL("/");

  const cardOnA = pageA.getByRole("article", { name: `Post by @${usernameA}` });
  await expect(cardOnA.getByRole("link", { name: "Edit post" })).toBeVisible();

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await registerViaUi(pageB);
  await pageB.goto("/");

  const cardOnB = pageB.getByRole("article", { name: `Post by @${usernameA}` });
  await expect(cardOnB).toBeVisible();
  await expect(cardOnB.getByRole("link", { name: "Edit post" })).toHaveCount(0);
  await expect(
    cardOnB.getByRole("button", { name: "Delete post" }),
  ).toHaveCount(0);

  // Navigating straight to the edit URL as a non-author is also blocked —
  // the backend would 403 anyway, but the UI shouldn't even show the form.
  const postId = await cardOnB.getAttribute("data-post-id");
  await pageB.goto(`/posts/${postId}/edit`);
  await expect(pageB.getByText("You can't edit this post")).toBeVisible();

  // The author, meanwhile, can actually edit it end-to-end.
  await cardOnA.getByRole("link", { name: "Edit post" }).click();
  await expect(pageA).toHaveURL(`/posts/${postId}/edit`);
  await pageA.fill("#content", "Edited by the author");
  await pageA.getByRole("button", { name: "Save changes" }).click();
  await expect(pageA).toHaveURL("/");
  await expect(pageA.getByText("Edited by the author")).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test("long posts are collapsed behind a Show more toggle", async ({
  page,
  request,
}) => {
  const { username } = await registerViaUi(page);

  // Longer than PostCard's 500-char collapse threshold — created directly
  // against the API since the point is to check the feed's rendering, not
  // the "new post" form.
  const longContent = "Lorem ipsum dolor sit amet.".repeat(30);
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const response = await request.post(`${API_URL}/posts`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    data: { contentType: "text", content: longContent },
  });
  expect(response.ok()).toBe(true);

  await page.goto("/");
  const card = page.getByRole("article", { name: `Post by @${username}` });
  await expect(card).toBeVisible();

  const showMore = card.getByRole("button", { name: "Show more" });
  await expect(showMore).toBeVisible();
  await expect(card.getByRole("button", { name: "Show less" })).toHaveCount(0);

  await showMore.click();
  await expect(card.getByRole("button", { name: "Show less" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Show more" })).toHaveCount(0);

  await card.getByRole("button", { name: "Show less" }).click();
  await expect(showMore).toBeVisible();
});
