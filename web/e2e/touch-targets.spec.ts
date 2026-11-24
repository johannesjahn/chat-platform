import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test, type TestUser } from "./fixtures";
import { longPress } from "./helpers";

// Issue #906: on a phone, a post's reaction row came apart once it had three
// kinds of reaction, a message's actions were 23px icons, several tabs and
// links were 16–28px tall, and a group's member actions were unlabelled
// icons. Every test here runs as a Pixel 7 (touch, no hover), whatever
// project it's in, so none is `@layout`.
// (Everything but `defaultBrowserType`, which can't be set per file.)
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } =
  devices["Pixel 7"];
test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

// WCAG 2.2's 2.5.8 minimum target size.
const MIN_TARGET = 24;
// The usual touch size (WCAG 2.5.5, Apple's and Google's guidelines).
const TOUCH_TARGET = 44;

const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "😡"];

// Entrance animations scale things in; measure their end state.
const FREEZE_MOTION = `*, *::before, *::after {
  transition: none !important;
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
}`;

function api(page: Page, apiUrl: string, user: TestUser) {
  const headers = { Authorization: `Bearer ${user.session.accessToken}` };
  return async (path: string, data?: unknown) => {
    const response = await page.request.post(`${apiUrl}${path}`, {
      headers,
      data,
    });
    expect(response.ok(), `POST ${path}`).toBe(true);
    return (await response.json()) as { id: number };
  };
}

// Every control on the page a finger could aim for that's smaller than
// `MIN_TARGET` either way, described for the failure message. Left out, as
// WCAG 2.5.8 leaves them out: links inside a sentence (`display: inline`),
// and what nobody can see or reach — invisible, `inert`, click-through or
// visually hidden (a file input behind its label).
function undersizedTargets(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    const selector = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      ...[
        "button",
        "link",
        "radio",
        "tab",
        "checkbox",
        "switch",
        "menuitem",
      ].map((role) => `[role=${role}]`),
    ].join(", ");
    const found: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (
        !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      )
        continue;
      if (el.closest("[inert]")) continue;
      const style = getComputedStyle(el);
      if (style.pointerEvents === "none" || style.display === "inline")
        continue;
      let { width, height } = el.getBoundingClientRect();
      if (width <= 1 || height <= 1) continue;
      // A checkbox or radio is also hit through its label.
      for (const label of (el as HTMLInputElement).labels ?? []) {
        const box = label.getBoundingClientRect();
        width = Math.max(width, box.width);
        height = Math.max(height, box.height);
      }
      if (width < min - 0.5 || height < min - 0.5) {
        const name =
          el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40);
        found.push(
          `${Math.round(width)}×${Math.round(height)} <${el.tagName.toLowerCase()}> "${name}"`,
        );
      }
    }
    return found;
  }, MIN_TARGET);
}

async function expectTargetsLargeEnough(page: Page, path: string) {
  await test.step(`targets: ${path}`, async () => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.addStyleTag({ content: FREEZE_MOTION });
    // Let lazy sections (a post's comments, a profile's posts) render.
    await page.waitForLoadState("networkidle");
    expect
      .soft(await undersizedTargets(page), `targets under 24px on ${path}`)
      .toEqual([]);
  });
}

test("every target on the main pages is at least 24×24px on a phone", async ({
  page,
  apiUrl,
  signUp,
  createUser,
}) => {
  test.setTimeout(120_000);
  const me = await signUp(page);
  const other = await createUser();
  const post = api(page, apiUrl, me);

  const { id: postId } = await post("/posts", {
    body: "Touch targets\n\nA post with a threaded comment under it.",
  });
  for (const emoji of REACTIONS.slice(0, 3)) {
    await post(`/posts/${postId}/reactions`, { emoji });
  }
  const { id: commentId } = await post(`/posts/${postId}/comments`, {
    content: "A first comment.",
  });
  await post(`/comments/${commentId}/replies`, { content: "A reply." });
  const { id: chatId } = await post("/chats/direct", {
    userId: other.session.user.id,
  });
  await post(`/chats/${chatId}/messages`, {
    body: "Hello there!",
  });
  const { id: lobbyId } = await post("/games/typing/lobbies");

  for (const path of [
    "/",
    `/posts/${postId}`,
    `/users/${me.session.user.id}`,
    "/users",
    "/chats",
    `/chats/${chatId}`,
    "/notifications",
    "/search?q=touch",
    "/settings",
    "/games",
    "/games/typing",
    `/games/typing/${lobbyId}`,
  ]) {
    await expectTargetsLargeEnough(page, path);
  }
});

// The centre line of each control in a post's action row, and the row's
// own height: one stable row means every control shares a centre line.
async function actionRow(card: Locator) {
  const controls = [
    card.getByRole("button", { name: "Add a reaction" }),
    card.getByRole("button", { name: /Comments/ }),
    ...REACTIONS.map((emoji) =>
      card.getByRole("button", { name: new RegExp(`${emoji} reaction$`) }),
    ),
  ];
  const centres: number[] = [];
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    centres.push(Math.round(box!.y + box!.height / 2));
  }
  const add = await controls[0]!.boundingBox();
  const comments = await controls[1]!.boundingBox();
  return { centres, add: add!, comments: comments! };
}

for (const width of [320, 412]) {
  test(`a post with all six reaction kinds keeps one stable action row at ${width}px`, async ({
    page,
    apiUrl,
    signUp,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const me = await signUp(page);
    const post = api(page, apiUrl, me);
    const { id: postId } = await post("/posts", {
      body: "Everyone has a feeling about this one.",
    });
    for (const emoji of REACTIONS) {
      await post(`/posts/${postId}/reactions`, { emoji });
    }

    for (const path of ["/", `/posts/${postId}`]) {
      await page.goto(path);
      const card = page.locator(`[data-post-id="${postId}"]`);
      await expect(
        card.getByRole("button", { name: "Remove 😡 reaction" }),
      ).toBeAttached();

      const before = await actionRow(card);
      for (const centre of before.centres) {
        expect(Math.abs(centre - before.centres[0]!)).toBeLessThanOrEqual(1);
      }
      // Nothing pushes the page sideways to make room.
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);

      // Reacting doesn't rearrange it: the add button and Comments stay put
      // as a chip goes, and as it comes back.
      await card.getByRole("button", { name: "Remove 👍 reaction" }).click();
      await expect(
        card.getByRole("button", { name: /👍 reaction$/ }),
      ).toHaveCount(0);
      const add = card.getByRole("button", { name: "Add a reaction" });
      const comments = card.getByRole("button", { name: /Comments/ });
      expect(await add.boundingBox()).toEqual(before.add);
      expect(await comments.boundingBox()).toEqual(before.comments);
      await add.click();
      await page.getByRole("button", { name: "React with 👍" }).click();
      await expect(
        card.getByRole("button", { name: "Remove 👍 reaction" }),
      ).toBeAttached();
      const after = await actionRow(card);
      expect(after.centres).toEqual(before.centres);
      expect(after.add).toEqual(before.add);
      expect(after.comments).toEqual(before.comments);
    }
  });
}

test("a long press opens a message's actions as labelled, finger-sized rows", async ({
  page,
  apiUrl,
  signUp,
  createUser,
}) => {
  const me = await signUp(page);
  const other = await createUser();
  const post = api(page, apiUrl, me);
  const { id: chatId } = await post("/chats/direct", {
    userId: other.session.user.id,
  });
  await post(`/chats/${chatId}/messages`, {
    body: "Hold me down",
  });

  await page.goto(`/chats/${chatId}`);
  const bubble = page
    .locator("[data-message-id]")
    .filter({ hasText: "Hold me down" });
  const sheet = await longPress(bubble.getByText("Hold me down"));
  await page.addStyleTag({ content: FREEZE_MOTION });

  // Each action is its own labelled row, not an icon to guess at.
  for (const label of [
    "Reply",
    "Forward",
    "Copy text",
    "Copy link",
    "Pin message",
    "Star message",
    "Edit message",
    "Delete message",
  ]) {
    await expect(
      sheet.getByRole("button", { name: label, exact: true }),
    ).toHaveText(label);
  }
  const buttons = sheet.getByRole("button");
  expect(await buttons.count()).toBe(REACTIONS.length + 8);
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(box!.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
  }

  // Choosing one closes the sheet and does it.
  await sheet.getByRole("button", { name: "Star message" }).click();
  await expect(sheet).toHaveCount(0);
  const again = await longPress(bubble.getByText("Hold me down"));
  await expect(
    again.getByRole("button", { name: "Unstar message" }),
  ).toBeVisible();
  // A tap on the backdrop puts it away with nothing chosen.
  await page.mouse.click(10, 10);
  await expect(again).toHaveCount(0);
});

test("a group's member actions are labelled with text on a phone", async ({
  page,
  apiUrl,
  signUp,
  createUser,
}) => {
  const me = await signUp(page);
  const bob = await createUser();
  const { id: chatId } = await api(
    page,
    apiUrl,
    me,
  )("/chats/group", {
    title: "Touch crew",
    participantIds: [bob.session.user.id],
  });

  await page.goto(`/chats/${chatId}`);
  await page.getByRole("button", { name: "Manage group" }).click();
  const dialog = page.getByRole("dialog", { name: "Group settings" });
  await expect(dialog).toBeVisible();

  for (const [name, text] of [
    [/^Make .+ an admin$/, "Make admin"],
    [/^Make .+ the owner$/, "Make owner"],
    [/^Remove .+/, "Remove"],
  ] as const) {
    const button = dialog.getByRole("button", { name });
    await expect(button).toBeVisible();
    await expect(button).toHaveText(text);
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TARGET);
  }
});
