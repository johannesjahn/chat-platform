import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Issue #753: creating a post or a comment used to fetch it back twice —
// once from the mutation's own invalidation and again from the realtime echo
// the server sends its author too. Now the response goes straight into the
// cache and the echo is dropped (see lib/ownWrites.ts). And a comment event
// used to refetch every open comment section, not just its own post's.

// Every request the page sends the backend, as "METHOD /path".
function recordApiRequests(page: Page, apiUrl: string) {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(apiUrl)) return;
    requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return requests;
}

// Loads `path` with nothing cached and waits until the app is up and quiet —
// `ready` on screen, the realtime socket connected and the refetches its
// first connect sets off back (see route-loaders.spec.ts).
async function openSettled(page: Page, path: string, ready: Locator) {
  const socketUp = new Promise<void>((resolve) =>
    page.on("websocket", (ws) => ws.once("framereceived", () => resolve())),
  );
  await page.goto(path);
  await expect(ready).toBeVisible();
  await socketUp;
  await page.waitForTimeout(500);
}

// Long enough for an echo's refetch to have gone out.
const settle = (page: Page) => page.waitForTimeout(1_000);

// Waits for the `<Collapse>` panel around `inside` to finish opening (see the
// same helper in reactions.spec.ts). While it grows it clips its content, and
// the focused composer inside has scrolled that clipped box; the scroll
// unwinds as the panel grows, moving the submit button between the press and
// the release — so on a loaded runner the click was lost and nothing posted.
async function waitForPanelAround(inside: Locator) {
  const panel = inside.locator(
    "xpath=ancestor::div[contains(concat(' ', @class, ' '), ' collapse-panel ')][1]",
  );
  await expect(panel).toHaveAttribute("data-settled", "");
  await expect
    .poll(() =>
      panel.evaluate((el) => el.getAnimations({ subtree: true }).length),
    )
    .toBe(0);
}

test("posting from the inline composer sends the post and nothing else", async ({
  page,
  apiUrl,
  signUp,
}) => {
  await signUp(page);
  const composer = page.getByRole("textbox", { name: "Write a post" });
  await openSettled(page, "/", composer);

  const requests = recordApiRequests(page, apiUrl);
  await composer.click();
  await composer.fill("Fresh off the composer");
  const postButton = page.getByRole("button", { name: "Post", exact: true });
  await waitForPanelAround(postButton);
  await postButton.click();
  await expect(
    page.locator("[data-post-id]").getByText("Fresh off the composer"),
  ).toBeVisible();
  await settle(page);

  expect(requests).toEqual(["POST /posts"]);
});

test("commenting and replying send the write and at most one read", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  await signUp(page);
  const author = await createUser();
  const post = await request.post(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${author.session.accessToken}` },
    data: { contentType: "text", content: "A post to comment on" },
  });
  const { id: postId } = await post.json();

  const card = page.locator(`[data-post-id="${postId}"]`);
  await openSettled(page, "/", card);
  await card.getByRole("button", { name: /^Comments/ }).click();
  await expect(card.getByText("No comments yet")).toBeVisible();
  await waitForPanelAround(card.getByPlaceholder("Write a comment…"));
  await settle(page);

  const requests = recordApiRequests(page, apiUrl);
  await card.getByPlaceholder("Write a comment…").fill("My own comment");
  await card.getByRole("button", { name: "Comment", exact: true }).click();
  const comments = card.locator('[data-testid="comment"]');
  await expect(comments.getByText("My own comment")).toBeVisible();
  // Counted from the response, not refetched.
  await expect(
    card.getByRole("button", { name: /^Hide comments · 1/ }),
  ).toBeVisible();
  await settle(page);
  expect(requests).toEqual([`POST /posts/${postId}/comments`]);

  // A reply opens its (not yet loaded) thread: that load is the one read.
  requests.length = 0;
  const comment = comments.first();
  const commentId = await comment.getAttribute("data-comment-id");
  await comment.getByRole("button", { name: "Reply" }).click();
  const replyBox = comment.getByPlaceholder(/^Reply to/);
  await waitForPanelAround(replyBox);
  await replyBox.fill("My own reply");
  await comment
    .getByRole("button", { name: "Reply", exact: true })
    .last()
    .click();
  // On a rendered reply, not the composer's text (the composer closes).
  await expect(replyBox).toHaveCount(0);
  await expect(comments.getByText("My own reply")).toBeVisible();
  await expect(
    card.getByRole("button", { name: /^Hide comments · 2/ }),
  ).toBeVisible();
  await settle(page);
  expect(requests).toEqual([
    `POST /comments/${commentId}/replies`,
    `GET /comments/${commentId}/replies`,
  ]);
});

test("a comment on one post doesn't refetch another post's open comments", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  await signUp(page);
  const author = await createUser();
  const as = { Authorization: `Bearer ${author.session.accessToken}` };
  const ids: number[] = [];
  for (const content of ["Post A", "Post B"]) {
    const post = await request.post(`${apiUrl}/posts`, {
      headers: as,
      data: { contentType: "text", content },
    });
    ids.push((await post.json()).id);
  }
  const [postA, postB] = ids;

  const cardA = page.locator(`[data-post-id="${postA}"]`);
  const cardB = page.locator(`[data-post-id="${postB}"]`);
  await openSettled(page, "/", cardB);
  for (const card of [cardA, cardB]) {
    await card.getByRole("button", { name: /^Comments/ }).click();
    await expect(card.getByText("No comments yet")).toBeVisible();
  }
  await settle(page);

  const requests = recordApiRequests(page, apiUrl);
  const comment = await request.post(`${apiUrl}/posts/${postA}/comments`, {
    headers: as,
    data: { content: "Only on A" },
  });
  expect(comment.ok()).toBe(true);
  await expect(cardA.getByText("Only on A")).toBeVisible();
  await settle(page);

  expect(requests).toContain(`GET /posts/${postA}/comments`);
  expect(requests).not.toContain(`GET /posts/${postB}/comments`);
});
