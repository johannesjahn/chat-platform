import { expect, test } from "./fixtures";
import { registerViaUi } from "./helpers";

test("reacting to a chat message from the hover button adds a pill below the bubble", async ({
  browser,
  injectApiUrl,
}) => {
  // A direct chat needs a second user to exist, but only A drives the UI —
  // A reacts to their own message (any participant may react, so the sender
  // reacting to their own message is a valid case and keeps the test to a
  // single page).
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  await registerViaUi(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const { username: usernameB } = await registerViaUi(pageB);

  await pageA.goto("/chats/new");
  await pageA.getByRole("button", { name: "Direct message" }).click();
  await pageA.fill("#user-search", usernameB);
  await pageA.getByRole("button", { name: `@${usernameB}` }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);

  await pageA.fill("textarea", "React to this chat message");
  await pageA.keyboard.press("Enter");
  const bubble = pageA
    .locator("[data-message-id]")
    .filter({ hasText: "React to this chat message" });
  await expect(bubble).toBeVisible();

  // The "add a reaction" trigger only appears on hover, beside the bubble —
  // the same hover-only affordance as the edit/delete buttons — rather than
  // occupying permanent space below every message.
  await bubble.hover();
  await bubble.getByRole("button", { name: "Add a reaction" }).click();
  await pageA.getByRole("button", { name: "React with 👍" }).click();

  const pill = bubble.getByRole("button", { name: "Remove 👍 reaction" });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText("👍1");

  // Toggling it back off removes the pill entirely, so no empty reaction row
  // is left behind under the bubble.
  await pill.click();
  await expect(
    bubble.getByRole("button", { name: "Remove 👍 reaction" }),
  ).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

test("long-pressing a chat message on touch opens the reaction picker (issue #309)", async ({
  browser,
  injectApiUrl,
}) => {
  // A touch-capable context: no hover state exists, so the desktop hover-reveal
  // of the action group can't fire — the long-press path is the only way in.
  const contextA = await browser.newContext({ hasTouch: true });
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  await registerViaUi(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const { username: usernameB } = await registerViaUi(pageB);

  await pageA.goto("/chats/new");
  await pageA.getByRole("button", { name: "Direct message" }).click();
  await pageA.fill("#user-search", usernameB);
  await pageA.getByRole("button", { name: `@${usernameB}` }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);

  await pageA.fill("textarea", "Long-press to react on mobile");
  await pageA.keyboard.press("Enter");
  const bubble = pageA
    .locator("[data-message-id]")
    .filter({ hasText: "Long-press to react on mobile" });
  await expect(bubble).toBeVisible();

  // Without a hover, the action group holding the "Add a reaction" trigger
  // stays fully transparent (opacity-0) — invisible and unusable to a real
  // touch user. (Playwright would still click through a transparent element,
  // so opacity is what's asserted here, not `toBeVisible`.)
  const addButton = bubble.getByRole("button", { name: "Add a reaction" });
  const actionGroup = bubble.locator("div", {
    has: pageA.getByRole("button", { name: "Add a reaction" }),
  });
  await expect(actionGroup).toHaveCSS("opacity", "0");

  // Emulate a stationary long press: dispatch a real touchstart on the bubble,
  // hold past the ~450ms threshold without moving, then release — exactly what
  // the component's onTouchStart/Move/End handlers listen for. Dispatched from
  // within the bubble so the event bubbles up to the handler on the content
  // column, and with no touchmove in between so the "moved → it's a scroll"
  // guard never cancels it.
  const target = bubble.getByText("Long-press to react on mobile");
  await target.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const touch = new Touch({
      identifier: 1,
      target: el,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    el.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      }),
    );
  });

  // Wait for the press to actually reveal the group (opacity animates to 1)
  // before lifting the finger — polling on the outcome rather than a fixed
  // hold avoids a race where a busy main thread delays the ~450ms timer past a
  // hard-coded wait, and the touchend then cancels it.
  await expect(actionGroup).toHaveCSS("opacity", "1");
  await target.evaluate((el) => {
    el.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [],
      }),
    );
  });

  // The group is revealed and stays put after release; open the picker and
  // react.
  await addButton.click();
  await pageA.getByRole("button", { name: "React with 👍" }).click();

  const pill = bubble.getByRole("button", { name: "Remove 👍 reaction" });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText("👍1");

  await contextA.close();
  await contextB.close();
});

test("a group chat shows the sender's avatar beside their message", async ({
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
  const { username: usernameB } = await registerViaUi(pageB);

  await pageA.goto("/chats/new");
  await pageA.getByRole("button", { name: "Group chat" }).click();
  await pageA.fill("#group-title", "Avatar squad");
  await pageA.fill("#user-search", usernameB);
  await pageA.getByRole("button", { name: `@${usernameB}` }).click();
  await pageA.getByRole("button", { name: /^Create group/ }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);
  const chatId = pageA.url().split("/").pop();

  await pageA.fill("textarea", "Hello from A in the group");
  await pageA.keyboard.press("Enter");
  await expect(pageA.getByText("Hello from A in the group")).toBeVisible();

  // B opens the group and sees A's incoming message with A's avatar linked to
  // A's profile next to it — the affordance that makes the sender identifiable
  // at a glance in a group. B's own messages don't get an avatar, so this link
  // is unambiguous.
  await pageB.goto(`/chats/${chatId}`);
  await expect(pageB.getByText("Hello from A in the group")).toBeVisible();
  await expect(
    pageB.getByRole("link", { name: `@${usernameA}'s profile` }),
  ).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test("adding and removing a reaction on a post updates the pill through the real API", async ({
  page,
}) => {
  await registerViaUi(page);
  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill("#content", "React to this post");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");

  const card = page.getByRole("article", { name: /^Post by / });
  await card.getByRole("button", { name: "Add a reaction" }).click();
  await page.getByRole("button", { name: "React with 👍" }).click();

  const pill = card.getByRole("button", { name: "Remove 👍 reaction" });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText("👍1");

  await pill.click();
  // Count drops back to zero, so the pill disappears entirely rather than
  // flipping to an "Add" state.
  await expect(
    card.getByRole("button", { name: "Remove 👍 reaction" }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Add 👍 reaction" }),
  ).toHaveCount(0);
});

test("a failed post reaction shows a visible error instead of silently doing nothing (issue #233)", async ({
  page,
  apiUrl,
}) => {
  await registerViaUi(page);
  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill("#content", "Reacting to this will fail");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");

  const card = page.getByRole("article", { name: /^Post by / });

  // Simulate the mutation being rejected server-side (e.g. the per-user
  // engagement rate limiter, or any other 4xx) rather than a raw network
  // failure — this is the case the two `toggleReaction` implementations
  // used to swallow entirely.
  await page.route(`${apiUrl}/posts/*/reactions`, (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ message: "Too many reactions, slow down" }),
    }),
  );

  await card.getByRole("button", { name: "Add a reaction" }).click();
  await page.getByRole("button", { name: "React with 👍" }).click();

  await expect(card.getByText("Too many reactions, slow down")).toBeVisible();
  // No pill was optimistically added for a mutation that never succeeded.
  await expect(
    card.getByRole("button", { name: "Remove 👍 reaction" }),
  ).toHaveCount(0);
});

test("a failed comment reaction shows a visible error instead of silently doing nothing (issue #233)", async ({
  page,
  apiUrl,
}) => {
  // A taller viewport keeps the comment's reaction trigger (and the fixed-
  // position emoji popover it opens, positioned just below it) fully
  // on-screen without Playwright needing to scroll mid-interaction — a
  // scroll while the popover is open closes it (see ReactionPicker's
  // "close on scroll" listener), which would otherwise race the click.
  await page.setViewportSize({ width: 1280, height: 1600 });
  await registerViaUi(page);
  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  await page.fill("#content", "Comment reactions can fail too");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL("/");

  const card = page.getByRole("article", { name: /^Post by / });
  await card.getByRole("button", { name: "Comments" }).click();
  await page.fill("textarea", "A comment to react to");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("A comment to react to")).toBeVisible();

  await page.route(`${apiUrl}/comments/*/reactions`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "Internal error reacting" }),
    }),
  );

  // Both the post and its one comment render a `ReactionPicker` — scope to
  // the comment itself (via its `data-testid`) so this doesn't accidentally
  // exercise the post's own reaction picker instead.
  const comment = page.getByTestId("comment").filter({
    hasText: "A comment to react to",
  });
  await comment.getByRole("button", { name: "Add a reaction" }).click();
  await page.getByRole("button", { name: "React with 😂" }).click();

  await expect(comment.getByText("Internal error reacting")).toBeVisible();
  await expect(
    comment.getByRole("button", { name: "Remove 😂 reaction" }),
  ).toHaveCount(0);
});
