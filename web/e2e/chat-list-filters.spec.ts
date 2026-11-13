import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test, type TestUser } from "./fixtures";
import { fakeOnScreenKeyboard } from "./helpers";

// Issue #763: the chat list's "Filter chats" box and All / Unread / Groups
// tabs — once only in the desktop list pane — are on the phone `/chats` page
// too, filtering the same shared `ChatList` the same way.

async function api<T>(
  request: APIRequestContext,
  url: string,
  user: TestUser,
  data: unknown,
): Promise<T> {
  const response = await request.post(url, {
    headers: { Authorization: `Bearer ${user.session.accessToken}` },
    data,
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as T;
}

// The list is the desktop layout's left pane, and the page itself below `lg`.
function chatList(page: Page) {
  const desktop = (page.viewportSize()?.width ?? 0) >= 1024;
  return desktop
    ? page.getByRole("complementary", { name: "Conversations" })
    : page.getByRole("main");
}

test(
  "the chat list filters by name, unread and groups on every layout",
  { tag: "@layout" },
  async ({ page, request, apiUrl, signUp, createUser }) => {
    test.setTimeout(60_000);
    const me = await signUp(page);
    const bob = await createUser();
    const carol = await createUser();
    const stranger = await createUser();

    // Bob's direct chat has an unread message; Carol's and the group are
    // read (the last message in each is mine).
    const bobChat = await api<{ id: number }>(
      request,
      `${apiUrl}/chats/direct`,
      bob,
      { userId: me.session.user.id },
    );
    await api(request, `${apiUrl}/chats/${bobChat.id}/messages`, bob, {
      contentType: "text",
      content: "Unread hello from Bob",
    });
    const carolChat = await api<{ id: number }>(
      request,
      `${apiUrl}/chats/direct`,
      me,
      { userId: carol.session.user.id },
    );
    await api(request, `${apiUrl}/chats/${carolChat.id}/messages`, me, {
      contentType: "text",
      content: "Hi Carol",
    });
    await api(request, `${apiUrl}/chats/group`, me, {
      title: "Weekend plans",
      participantIds: [bob.session.user.id, carol.session.user.id],
    });
    // A stranger's group is a message request (issue #785): never in the
    // list, whatever the filter, but its entry stays on top of it.
    await api(request, `${apiUrl}/chats/group`, stranger, {
      title: "Stranger danger",
      participantIds: [me.session.user.id],
    });

    await page.goto("/chats");
    const list = chatList(page);
    const dm = (user: TestUser) =>
      list.getByRole("link", { name: new RegExp(`^@${user.username}`) });
    const group = list.getByRole("link", { name: /^Weekend plans/ });
    const requests = list.getByRole("link", { name: /Message requests/ });
    const box = list.getByRole("searchbox", { name: "Filter chats" });
    const show = list.getByRole("radiogroup", { name: "Show" });
    const tab = (name: string) => show.getByRole("radio", { name });

    await expect(dm(bob)).toBeVisible();
    await expect(dm(carol)).toBeVisible();
    await expect(group).toBeVisible();
    await expect(requests).toBeVisible();
    await expect(tab("All")).toHaveAttribute("aria-checked", "true");

    // By name.
    await box.fill(carol.username);
    await expect(dm(carol)).toBeVisible();
    await expect(dm(bob)).toHaveCount(0);
    await expect(group).toHaveCount(0);
    // There's nothing to submit, so Enter — the on-screen keyboard's search
    // key — just puts the keyboard away.
    await box.press("Enter");
    await expect(box).not.toBeFocused();
    await expect(dm(carol)).toBeVisible();
    await box.fill("nobody-by-this-name");
    await expect(list.getByText("No chats match.")).toBeVisible();
    await box.fill("");
    await expect(dm(bob)).toBeVisible();

    // Unread: the server-side list (issue #756).
    await tab("Unread").click();
    await expect(tab("Unread")).toHaveAttribute("aria-checked", "true");
    await expect(dm(bob)).toBeVisible();
    await expect(dm(carol)).toHaveCount(0);
    await expect(group).toHaveCount(0);
    await expect(requests).toBeVisible();

    // Groups.
    await tab("Groups").click();
    await expect(group).toBeVisible();
    await expect(dm(bob)).toHaveCount(0);
    await expect(dm(carol)).toHaveCount(0);
    await expect(list.getByText("Stranger danger")).toHaveCount(0);
    await expect(requests).toBeVisible();

    // The filter outlives opening a chat and coming back — on a phone that's
    // a page of its own, on a desktop the pane stays beside it.
    await group.click();
    await expect(page).toHaveURL(/\/chats\/\d+$/);
    await page.goBack();
    await expect(page).toHaveURL("/chats");
    await expect(tab("Groups")).toHaveAttribute("aria-checked", "true");
    await expect(group).toBeVisible();
    await expect(dm(bob)).toHaveCount(0);

    await tab("All").click();
    await expect(dm(bob)).toBeVisible();
    await expect(dm(carol)).toBeVisible();
    await expect(group).toBeVisible();
  },
);

test("the phone chat list's filters fit a 390px screen with the keyboard up", async ({
  page,
  request,
  apiUrl,
  signUp,
  createUser,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeOnScreenKeyboard(page);
  const me = await signUp(page);
  const bob = await createUser();
  await api(request, `${apiUrl}/chats/direct`, me, {
    userId: bob.session.user.id,
  });

  await page.goto("/chats");
  const list = page.getByRole("main");
  const box = list.getByRole("searchbox", { name: "Filter chats" });
  const show = list.getByRole("radiogroup", { name: "Show" });
  await expect(box).toBeInViewport({ ratio: 1 });
  await expect(show).toBeInViewport({ ratio: 1 });
  for (const name of ["All", "Unread", "Groups"]) {
    await expect(show.getByRole("radio", { name })).toBeInViewport({
      ratio: 1,
    });
  }
  // Nothing pushes the page sideways.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  // With the keyboard taking the bottom half, the box (right under the
  // header) and the first results stay above it.
  await box.focus();
  await page.evaluate(() => window.__shrinkVisualViewport(400));
  await box.fill(bob.username);
  const boxBottom = await box.evaluate(
    (node) => node.getBoundingClientRect().bottom,
  );
  expect(boxBottom).toBeLessThanOrEqual(400);
  await expect(
    list.getByRole("link", { name: new RegExp(`^@${bob.username}`) }),
  ).toBeVisible();
  await box.press("Enter");
  await expect(box).not.toBeFocused();
});
