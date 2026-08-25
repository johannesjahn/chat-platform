import { expect, test } from "./fixtures";
import { makeSolidPng, registerViaUi } from "./helpers";

test("creating a post shows it in the feed, and infinite scroll loads more posts in batches of 5 then 3", async ({
  page,
  request,
  apiUrl,
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
  //
  // Each seeded post is deliberately tall (several short lines, still well
  // under PostCard's 500-char collapse threshold so it renders in full).
  // The feed's IntersectionObserver eagerly prefetches the next batch while
  // the sentinel is within 400px of the viewport (see web/src/routes/
  // index.tsx), so if the first 5 cards didn't overflow the viewport the
  // sentinel would be visible on load and batch 2 would auto-load before we
  // could observe the 5-post state — making `toHaveCount(5)` racily flaky.
  // Tall cards push the sentinel out of the prefetch zone, so the second
  // batch only loads on the explicit scroll below, which is the whole point
  // of this test.
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  for (let i = 0; i < 7; i++) {
    const content = Array.from(
      { length: 8 },
      (_, line) => `Seeded post ${i} line ${line}`,
    ).join("\n");
    const response = await request.post(`${apiUrl}/posts`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      data: { contentType: "text", content },
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

test("a post created by one user appears live in another user's already-open feed", async ({
  browser,
  injectApiUrl,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const { username: usernameA } = await registerViaUi(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  await registerViaUi(pageB);

  // B sits on the feed and just leaves it open — no reload from here on, so
  // anything B sees has to come from the `/ws` push invalidating the feed
  // query, not a fresh load.
  await pageB.goto("/");
  await expect(pageB.getByText("No posts yet")).toBeVisible();

  await pageA.goto("/posts/new");
  await pageA.fill("#content", "Posted while B is watching the feed");
  await pageA.getByRole("button", { name: "Post" }).click();
  await expect(pageA).toHaveURL("/");

  await expect(
    pageB.getByText("Posted while B is watching the feed"),
  ).toBeVisible({ timeout: 10_000 });

  // An edit by A should likewise reach B's open feed live.
  const cardOnA = pageA.getByRole("article", { name: `Post by @${usernameA}` });
  await cardOnA.getByRole("link", { name: "Edit post" }).click();
  await pageA.fill("#content", "Edited while B is watching the feed");
  await pageA.getByRole("button", { name: "Save changes" }).click();
  await expect(pageA).toHaveURL("/");

  await expect(
    pageB.getByText("Edited while B is watching the feed"),
  ).toBeVisible({ timeout: 10_000 });

  await contextA.close();
  await contextB.close();
});

test("edit is only available to a post's author, both in the UI and when navigating directly", async ({
  browser,
  injectApiUrl,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const { username: usernameA } = await registerViaUi(pageA);

  await pageA.goto("/posts/new");
  await pageA.fill("#content", "Only the author should be able to edit this");
  await pageA.getByRole("button", { name: "Post" }).click();
  await expect(pageA).toHaveURL("/");

  const cardOnA = pageA.getByRole("article", { name: `Post by @${usernameA}` });
  await expect(cardOnA.getByRole("link", { name: "Edit post" })).toBeVisible();

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
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
  apiUrl,
}) => {
  const { username } = await registerViaUi(page);

  // Longer than PostCard's 500-char collapse threshold — created directly
  // against the API since the point is to check the feed's rendering, not
  // the "new post" form.
  const longContent = "Lorem ipsum dolor sit amet.".repeat(30);
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const response = await request.post(`${apiUrl}/posts`, {
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

test("clicking a feed image post opens it full-size in a lightbox", async ({
  page,
  request,
  apiUrl,
}) => {
  const { username } = await registerViaUi(page);

  // Seed an image post directly against the API — the point here is the
  // feed's lightbox behavior, not the "new post" upload flow. The host is on
  // the backend's image-URL allowlist (see ALLOWED_IMAGE_HOST_DOMAINS); the
  // image itself never has to load for the card's click target to exist.
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const response = await request.post(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    data: {
      contentType: "image_url",
      content: "https://picsum.photos/seed/lightbox/600/800",
    },
  });
  expect(response.ok()).toBe(true);

  await page.goto("/");
  const card = page.getByRole("article", { name: `Post by @${username}` });
  await expect(card).toBeVisible();

  // No lightbox until the image is clicked.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await card.getByRole("button", { name: "View image full-size" }).click();
  const lightbox = page.getByRole("dialog", { name: "Image" });
  await expect(lightbox).toBeVisible();

  // Esc closes it again.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the full-screen viewer zooms and pans an image past its on-page size", async ({
  page,
  request,
  apiUrl,
}) => {
  await registerViaUi(page);
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const headers = { Authorization: `Bearer ${session.accessToken}` };

  // An attachment post (rather than an image-URL one) so the image is served
  // by the test backend and actually decodes in the browser — the viewer's
  // zoom math is driven by the image's natural size, so it needs a real one.
  // Tall and narrow: at fit scale it's letterboxed, and one zoom step makes
  // it overflow vertically, which is what gives the pan something to do.
  const upload = await request.post(`${apiUrl}/attachments`, {
    headers,
    multipart: {
      file: {
        name: "tall.png",
        mimeType: "image/png",
        buffer: makeSolidPng(400, 1200, [90, 130, 220]),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const attachment = await upload.json();
  const post = await request.post(`${apiUrl}/posts`, {
    headers,
    data: {
      contentType: "attachment",
      // The composer sends the filename as the post's content for
      // attachment posts (see ChatComposer/PostForm) — mirrored here.
      content: attachment.filename,
      attachmentId: attachment.id,
    },
  });
  expect(post.ok()).toBe(true);

  await page.goto("/");
  await page
    .getByRole("button", { name: "View tall.png full-size" })
    .first()
    .click();

  const viewer = page.getByRole("dialog", { name: "tall.png" });
  const image = viewer.getByRole("img", { name: "tall.png" });
  await expect(image).toBeVisible();

  const viewport = page.viewportSize()!;
  const box = async () => (await image.boundingBox())!;
  const roundedHeight = async () => Math.round((await box()).height);

  // It opens fit to the *screen* — a 400x1200 image in a 1280x720 viewport
  // is letterboxed to exactly the viewport height (and 400px wide in the
  // feed card it came from, so this is already several times bigger).
  await expect.poll(roundedHeight).toBe(viewport.height);
  const fit = await box();

  // Zooming in makes it genuinely bigger than the fitted view...
  await viewer.getByRole("button", { name: "Zoom in" }).click();
  await expect
    .poll(async () => (await box()).width)
    .toBeGreaterThan(fit.width * 1.3);
  const zoomed = await box();

  // ...and now that it overflows the viewport, the wheel scrolls it, which
  // the old fit-only viewer couldn't do at all.
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.wheel(0, 250);
  await expect
    .poll(async () => Math.round((await box()).y))
    .toBeLessThan(Math.round(zoomed.y));

  // "0" resets to the fitted view, where zooming out is a no-op again.
  const zoomOut = viewer.getByRole("button", { name: "Zoom out" });
  await expect(zoomOut).toBeEnabled();
  await page.keyboard.press("0");
  await expect.poll(roundedHeight).toBe(viewport.height);
  await expect(zoomOut).toBeDisabled();

  // Finally, a drag down from the fitted view throws the viewer away —
  // the mobile-style dismissal, which works with a mouse too.
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewport.width / 2, viewport.height / 2 + 260, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
