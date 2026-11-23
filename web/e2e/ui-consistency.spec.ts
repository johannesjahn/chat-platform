import { expect, test } from "./fixtures";

// Issue #898: a pass over small UI inconsistencies.

test("a missing user shows the shared not-found state, not the server's message", async ({
  page,
  signUp,
}) => {
  await signUp(page);
  await page.goto("/users/99999");
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { level: 1, name: "User not found" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("User not found · Chat Platform");
  await expect(main.getByText("User 99999 not found")).toHaveCount(0);

  await main.getByRole("link", { name: "Find people" }).click();
  await expect(page).toHaveURL("/users");
});

test("a lobby that never existed and one that has closed read the same", async ({
  page,
  signUp,
}) => {
  await signUp(page);
  const main = page.getByRole("main");

  await page.goto("/games/lobbies/999");
  await expect(main.getByText("Lobby not found")).toBeVisible();

  await page.goto("/games/typing/999999");
  await expect(main.getByText("Lobby not found")).toBeVisible();
  await expect(main.getByText("This lobby has closed")).toHaveCount(0);
  await main.getByRole("link", { name: "Browse lobbies" }).click();
  await expect(page).toHaveURL("/games/typing");
});

test("a post of many short lines and a long comment both collapse", async ({
  page,
  apiUrl,
  request,
  signUp,
  createUser,
}) => {
  await signUp(page);
  const author = await createUser();
  const headers = { Authorization: `Bearer ${author.session.accessToken}` };

  // Well under the 500-character budget, but 40 lines tall.
  const manyLines = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
  const post = await request.post(`${apiUrl}/posts`, {
    headers,
    data: { contentType: "text", content: manyLines },
  });
  expect(post.ok()).toBe(true);
  const { id: postId } = await post.json();

  const longComment = "A rather long comment sentence. ".repeat(40).trim();
  const comment = await request.post(`${apiUrl}/posts/${postId}/comments`, {
    headers,
    data: { content: longComment },
  });
  expect(comment.ok()).toBe(true);

  await page.goto("/");
  const card = page.locator(`[data-post-id="${postId}"]`);
  await expect(card.getByRole("button", { name: "Show more" })).toBeVisible();

  // The post's page shows the post in full, but the comment still collapses.
  await page.goto(`/posts/${postId}`);
  const main = page.getByRole("main");
  const body = main.locator("p", { hasText: longComment });
  await expect(body).toHaveClass(/line-clamp-6/);
  const showMore = main.getByRole("button", { name: "Show more" });
  await expect(showMore).toHaveCount(1);
  await showMore.click();
  await expect(body).not.toHaveClass(/line-clamp/);
  await expect(main.getByRole("button", { name: "Show less" })).toBeVisible();
});

test("a profile only names the site role when it's Admin", async ({
  page,
  signUp,
  createUser,
}) => {
  await signUp(page);
  const other = await createUser();
  await page.goto(`/users/${other.session.user.id}`);
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { level: 1, name: `@${other.username}` }),
  ).toBeVisible();
  await expect(main.getByText("User", { exact: true })).toHaveCount(0);
});
