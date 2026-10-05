import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

// Issue #530: at phone width the search filter chips and a comment's action
// row each wrapped their last item (Messages, Delete) alone onto a second
// line. Both rows now stay on one line.
test.use({ viewport: { width: 390, height: 844 } });

async function top(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return Math.round(box!.y);
}

test("the search filter chips stay on one row", async ({ page, signUp }) => {
  await signUp(page);
  await page.goto("/search?q=lorem");

  const all = page.getByRole("button", { name: "All", exact: true });
  const messages = page.getByRole("button", { name: "Messages", exact: true });
  await expect(messages).toBeVisible();
  expect(await top(messages)).toBe(await top(all));
  // ...and at this width all of them fit without scrolling the row.
  const overflow = await messages
    .locator("..")
    .evaluate((row) => row.scrollWidth - row.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("an own comment's actions stay on one row", async ({
  page,
  apiUrl,
  request,
  signUp,
}) => {
  await signUp(page);
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const headers = { Authorization: `Bearer ${session.accessToken}` };

  const post = await request.post(`${apiUrl}/posts`, {
    headers,
    data: { contentType: "text", content: "A post to comment on" },
  });
  const { id: postId } = await post.json();
  const comment = await request.post(`${apiUrl}/posts/${postId}/comments`, {
    headers,
    data: { content: "My own comment" },
  });
  const { id: commentId } = await comment.json();
  // A reaction pill widens the row, as it would on a busy thread.
  const reaction = await request.post(
    `${apiUrl}/comments/${commentId}/reactions`,
    {
      headers,
      data: { emoji: "👍" },
    },
  );
  expect(reaction.ok()).toBe(true);

  await page.goto(`/posts/${postId}`);
  const item = page.locator(`[data-comment-id="${commentId}"]`);
  const reply = item.getByRole("button", { name: "Reply", exact: true });
  const edit = item.getByRole("button", { name: "Edit", exact: true });
  const del = item.getByRole("button", { name: "Delete", exact: true });
  await expect(del).toBeVisible();
  const row = await top(reply);
  expect(await top(edit)).toBe(row);
  expect(await top(del)).toBe(row);
});
