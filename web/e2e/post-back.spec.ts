import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// The post page's back control returns to wherever the post was opened from
// — with that page's scroll position — rather than always to the feed
// (issue #762). Only a post with nothing in-app before it (a direct load, a
// new tab, a shared link) falls back to "Back to feed".

async function seedPosts(
  page: Page,
  request: APIRequestContext,
  apiUrl: string,
  contents: string[],
): Promise<{ authorId: number; ids: number[] }> {
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const ids: number[] = [];
  let authorId = 0;
  for (const content of contents) {
    const response = await request.post(`${apiUrl}/posts`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      data: { contentType: "text", content },
    });
    expect(response.ok()).toBe(true);
    const post = await response.json();
    ids.push(post.id);
    authorId = post.authorId;
  }
  return { authorId, ids };
}

test(
  "a post opened from a profile goes back to it, scroll position and all",
  { tag: "@layout" },
  async ({ page, request, apiUrl, signUp }) => {
    await signUp(page);
    const { authorId, ids } = await seedPosts(
      page,
      request,
      apiUrl,
      Array.from({ length: 10 }, (_, i) => `Profile post ${i + 1}`),
    );

    await page.goto(`/users/${authorId}`);
    // Newest first, five to a page. Scroll to the bottom until the second
    // page is in too, so nothing grows the list once it's measured.
    await expect(async () => {
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await expect(page.locator(`[data-post-id="${ids[0]}"]`)).toBeAttached({
        timeout: 1000,
      });
    }).toPass();
    // "Profile post 6", partway down the list.
    const target = page.locator(`[data-post-id="${ids[5]}"]`).first();
    const openLink = target.getByRole("link", { name: "Open post" });
    await openLink.scrollIntoViewIfNeeded();
    // Let the scroll settle before reading it.
    let scrollY = -1;
    await expect(async () => {
      const before = scrollY;
      scrollY = await page.evaluate(() => window.scrollY);
      expect(scrollY).toBe(before);
    }).toPass();
    expect(scrollY).toBeGreaterThan(0);

    await openLink.click();
    await expect(page).toHaveURL(/\/posts\/\d+$/);
    await expect(page.getByRole("main")).toContainText("Profile post 6");

    const back = page.getByRole("link", { name: "Back to profile" });
    await expect(back).toHaveAttribute("href", `/users/${authorId}`);
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/users/${authorId}$`));
    // A step back through history, not a new entry on top of the post.
    await page.goForward();
    await expect(page).toHaveURL(/\/posts\/\d+$/);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/users/${authorId}$`));
    await expect(target).toBeVisible();
    // Back to where it was scrolled, not the top of the profile.
    await expect
      .poll(async () =>
        Math.abs((await page.evaluate(() => window.scrollY)) - scrollY),
      )
      .toBeLessThan(50);
  },
);

test(
  "a post opened from search results goes back to the results",
  { tag: "@layout" },
  async ({ page, request, apiUrl, signUp }) => {
    await signUp(page);
    await seedPosts(page, request, apiUrl, [
      "The peregrine falcon dives at incredible speed",
    ]);

    await page.goto("/search?q=peregrine");

    await page
      .getByRole("link")
      .filter({ hasText: "peregrine" })
      .first()
      .click();
    await expect(page).toHaveURL(/\/posts\/\d+$/);

    await page.getByRole("link", { name: "Back to search" }).click();
    await expect(page).toHaveURL(/\/search\?q=peregrine/);
    await expect(page.locator("mark", { hasText: "peregrine" })).toBeVisible();
  },
);

test(
  "a directly loaded post falls back to the feed",
  { tag: "@layout" },
  async ({ page, request, apiUrl, signUp }) => {
    await signUp(page);
    const { ids } = await seedPosts(page, request, apiUrl, [
      "A post someone shared a link to",
    ]);

    await page.goto(`/posts/${ids[0]}`);
    await expect(page.getByRole("main")).toContainText(
      "A post someone shared a link to",
    );
    const back = page.getByRole("link", { name: "Back to feed" });
    await expect(back).toHaveAttribute("href", "/");
    await back.click();
    await expect(page).toHaveURL(/\/$/);
  },
);
