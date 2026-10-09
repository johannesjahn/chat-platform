import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test, type TestUser } from "./fixtures";
import { makeSolidPng } from "./helpers";

// Issue #554: from `lg` (1024px) up the app is laid out for a desktop — a
// sidebar instead of the top bar, two-pane chats, docked chat windows, a
// command palette — and below it nothing changes. The rest of the suite runs
// at Playwright's 1280px desktop; this file covers what's new there, at a
// wide 1440px screen, and checks the phone layout is still the phone one.

test.use({ viewport: { width: 1440, height: 900 } });
// Most tests here drive two users' worth of setup.
test.describe.configure({ timeout: 60_000 });

const as = (user: TestUser) => ({
  Authorization: `Bearer ${user.session.accessToken}`,
});

async function directChat(
  request: APIRequestContext,
  apiUrl: string,
  from: TestUser,
  to: TestUser,
): Promise<number> {
  const response = await request.post(`${apiUrl}/chats/direct`, {
    headers: as(from),
    data: { userId: to.session.user.id },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: number }).id;
}

async function send(
  request: APIRequestContext,
  apiUrl: string,
  from: TestUser,
  chatId: number,
  content: string,
) {
  const response = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
    headers: as(from),
    data: { contentType: "text", content },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: number };
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Main" });

test("the sidebar replaces the top bar, marks where you are, and holds the account menu", async ({
  page,
  signUp,
}) => {
  const { username } = await signUp(page);

  await expect(page.locator("[data-app-sidebar]")).toBeVisible();
  await expect(page.locator("[data-app-nav]")).toHaveCount(0);
  await expect(
    sidebar(page).getByRole("link", { name: "Feed" }),
  ).toHaveAttribute("aria-current", "page");

  await sidebar(page).getByRole("link", { name: "Users" }).click();
  await expect(page).toHaveURL("/users");
  await expect(
    sidebar(page).getByRole("link", { name: "Users" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    sidebar(page).getByRole("link", { name: "Feed" }),
  ).not.toHaveAttribute("aria-current");

  const accountMenu = page.getByRole("button", {
    name: `Account menu for @${username}`,
  });
  await accountMenu.click();
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu.getByRole("menuitem")).toHaveCount(4);
  // It's a real menu: focus moves in, and Escape hands it back.
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(accountMenu).toBeFocused();

  await accountMenu.click();
  await menu.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeVisible();
});

test("navigating animates only the page, and re-clicking where you are does nothing", async ({
  page,
  signUp,
}) => {
  // Issue #574: the page column is the only thing that animates on a change
  // of page; the sidebar is captured on its own so it stays still, and a
  // navigation that keeps the pathname runs no view transition at all.
  await signUp(page);

  const transitionName = (selector: string) =>
    page
      .locator(selector)
      .evaluate((el) => getComputedStyle(el).viewTransitionName);
  expect(await transitionName("[data-app-sidebar]")).toBe("app-nav");
  expect(await transitionName("[data-app-column]")).toBe("app-content");

  // Count the transitions the router starts (and still run them, so the
  // navigation itself is untouched).
  await page.evaluate(() => {
    const w = window as unknown as { viewTransitions: number };
    w.viewTransitions = 0;
    const start = document.startViewTransition?.bind(document);
    document.startViewTransition = ((arg: Parameters<typeof start>[0]) => {
      w.viewTransitions++;
      return start(arg);
    }) as typeof document.startViewTransition;
  });
  const transitions = () =>
    page.evaluate(
      () => (window as unknown as { viewTransitions: number }).viewTransitions,
    );

  const users = sidebar(page).getByRole("link", { name: "Users" });
  await users.click();
  await expect(page).toHaveURL(/\/users$/);
  await expect(users).toHaveAttribute("aria-current", "page");
  await expect.poll(transitions).toBe(1);

  const historyLength = await page.evaluate(() => history.length);
  await users.click();
  await expect(page).toHaveURL(/\/users$/);
  // Give a (wrongly) started transition time to show up before asserting
  // there was none.
  await page.waitForTimeout(500);
  expect(await transitions()).toBe(1);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test("chats open beside the list, and Alt+↓ moves to the next one", async ({
  page,
  request,
  apiUrl,
  signUp,
  createUser,
}) => {
  const me = await signUp(page);
  const bob = await createUser();
  const carol = await createUser();
  const bobChat = await directChat(request, apiUrl, bob, me);
  await send(request, apiUrl, bob, bobChat, "Hello from Bob");
  const carolChat = await directChat(request, apiUrl, carol, me);
  await send(request, apiUrl, carol, carolChat, "Hello from Carol");

  await page.goto("/chats");
  const list = page.getByRole("complementary", { name: "Conversations" });
  await expect(
    page.getByRole("heading", { name: "Select a conversation" }),
  ).toBeVisible();

  // Newest first: Carol, then Bob.
  const row = (user: TestUser) =>
    list.getByRole("link", { name: new RegExp(`^@${user.username}`) });
  await row(carol).click();
  await expect(page).toHaveURL(`/chats/${carolChat}`);
  await expect(
    page.getByRole("main").getByText("Hello from Carol"),
  ).toBeVisible();
  // The list stays put, with the open chat marked, and there's nothing to
  // go "back" to.
  await expect(row(carol)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Back to chats" })).toBeHidden();
  // Opening a chat on a desktop puts you in the composer.
  await expect(
    page.getByRole("textbox", { name: /Write a message/ }),
  ).toBeFocused();

  await page.keyboard.press("Alt+ArrowDown");
  await expect(page).toHaveURL(`/chats/${bobChat}`);
  await expect(
    page.getByRole("main").getByText("Hello from Bob"),
  ).toBeVisible();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page).toHaveURL(`/chats/${carolChat}`);

  // The list pane filters by name.
  await list
    .getByRole("searchbox", { name: "Filter chats" })
    .fill(bob.username);
  await expect(row(carol)).toHaveCount(0);
  await expect(row(bob)).toBeVisible();
});

test("a docked chat window opens over the feed and survives a reload", async ({
  page,
  request,
  apiUrl,
  signUp,
  createUser,
}) => {
  const me = await signUp(page);
  const bob = await createUser();
  const chatId = await directChat(request, apiUrl, bob, me);
  await send(request, apiUrl, bob, chatId, "Ping from Bob");

  await page.goto("/");
  const messaging = page.getByRole("region", { name: "Messaging" });
  await messaging.getByRole("button", { name: /Messaging/ }).click();
  await messaging
    .getByRole("button", { name: new RegExp(bob.username) })
    .click();

  const window = page.getByRole("region", {
    name: `Chat with @${bob.username}`,
  });
  await expect(window.getByText("Ping from Bob")).toBeVisible();
  await expect(page).toHaveURL("/");

  // Sending from it is sending in the chat.
  await window
    .getByRole("textbox", { name: /Write a message/ })
    .fill("Reply from the dock");
  // Waited on before the reload below: a reload that aborts a send still in
  // flight leaves it to the offline queue to retry.
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/chats/${chatId}/messages`),
  );
  await page.keyboard.press("Enter");
  await sent;
  await expect(window.getByText("Reply from the dock")).toBeVisible();

  // Open windows are remembered on this device.
  await page.reload();
  await expect(window.getByText("Reply from the dock")).toBeVisible();

  // Minimised, it's just its header; closed, it's gone.
  await window.getByRole("button", { name: "Minimize", exact: true }).click();
  await expect(window.getByText("Reply from the dock")).toHaveCount(0);
  await window
    .getByRole("button", { name: `Close chat with @${bob.username}` })
    .click();
  await expect(window).toHaveCount(0);

  // The dock isn't shown on /chats — the two-pane view already is the
  // messenger.
  await page.goto("/chats");
  await expect(messaging).toHaveCount(0);
});

test("Ctrl+K jumps to a chat, and / searches", async ({
  page,
  request,
  apiUrl,
  signUp,
  createUser,
}) => {
  const me = await signUp(page);
  const bob = await createUser();
  const chatId = await directChat(request, apiUrl, me, bob);

  await page.goto("/");
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", {
    name: "Search and quick switcher",
  });
  const box = palette.getByRole("combobox");
  await expect(box).toBeFocused();
  await box.fill(bob.username);
  await expect(
    palette.getByRole("option", { name: `@${bob.username}` }),
  ).toBeVisible();
  // The switcher highlights its top match, so Enter opens it.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/chats/${chatId}`);
  await expect(palette).toHaveCount(0);

  // `/` opens it for searching: Enter goes to the full results.
  await page.getByRole("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("/");
  await expect(box).toBeFocused();
  await box.fill("falcon");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/search?q=falcon");
});

test("a file dropped on the conversation becomes the attachment, and ↑ edits your last message", async ({
  page,
  request,
  apiUrl,
  signUp,
  createUser,
}) => {
  const me = await signUp(page);
  const bob = await createUser();
  const chatId = await directChat(request, apiUrl, me, bob);
  await send(request, apiUrl, me, chatId, "A message to edit");

  await page.goto(`/chats/${chatId}`);
  const composer = page.getByRole("textbox", { name: /Write a message/ });
  await expect(composer).toBeFocused();

  // ↑ in the empty composer opens your newest message's editor; Escape
  // backs out and returns to the composer.
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("button", { name: "Save edit" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Save edit" })).toHaveCount(0);
  await expect(composer).toBeFocused();

  // Drop a file anywhere on the thread — not just on the upload field.
  const png = makeSolidPng(32, 32, [40, 160, 220]);
  const dataTransfer = await page.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }),
    );
    return transfer;
  }, Array.from(png));
  const thread = page.getByTestId("chat-scroll");
  await thread.dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByText("Drop to attach")).toBeVisible();
  await thread.dispatchEvent("drop", { dataTransfer });
  await expect(page.getByText("Drop to attach")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Cancel attachment" }),
  ).toBeVisible();
});

test("the tab title carries the unread count", async ({
  page,
  request,
  apiUrl,
  signUp,
  createUser,
}) => {
  const me = await signUp(page);
  await expect(page).toHaveTitle("Feed · Chat Platform");
  const bob = await createUser();
  const chatId = await directChat(request, apiUrl, bob, me);
  await send(request, apiUrl, bob, chatId, "Are you there?");

  await expect(page).toHaveTitle("(1) Feed · Chat Platform");
  // Reading it clears it again.
  await page.goto(`/chats/${chatId}`);
  await expect(page).toHaveTitle(`@${bob.username} · Chat Platform`);
});

test.describe("below lg", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the phone layout is unchanged: top bar, single-pane chats, no dock", async ({
    page,
    request,
    apiUrl,
    signUp,
    createUser,
  }) => {
    const me = await signUp(page);
    const bob = await createUser();
    const chatId = await directChat(request, apiUrl, bob, me);
    await send(request, apiUrl, bob, chatId, "Hi on a phone");

    await expect(page.locator("[data-app-nav]")).toBeVisible();
    await expect(page.locator("[data-app-sidebar]")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Messaging" })).toHaveCount(
      0,
    );

    await page.goto("/chats");
    await expect(
      page.getByRole("complementary", { name: "Conversations" }),
    ).toHaveCount(0);
    await page
      .getByRole("link", { name: new RegExp(bob.username) })
      .last()
      .click();
    await expect(page).toHaveURL(`/chats/${chatId}`);
    // The conversation is the whole screen again, with its back button.
    await expect(
      page.getByRole("link", { name: "Back to chats" }),
    ).toBeVisible();
    await expect(page.locator("[data-app-nav]")).toBeHidden();
  });
});
