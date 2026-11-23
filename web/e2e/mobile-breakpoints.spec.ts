import type { Page } from "@playwright/test";
import { expect, test, type TestUser } from "./fixtures";

// Issue #905: the phone layout was only exercised at a 390–412px portrait
// phone. Around it, a tablet's bar wrapped onto two rows, a landscape phone's
// squeezed the search box under the account name, a landscape conversation
// kept the site nav and showed about one bubble, and `/chats` scrolled
// sideways at 320px. Each test sets its own viewport, so none is `@layout`.
const VIEWPORTS = [
  { name: "320px phone", width: 320, height: 568 },
  { name: "390px phone", width: 390, height: 844 },
  { name: "tablet portrait", width: 768, height: 1024 },
  { name: "phone landscape", width: 915, height: 412 },
];

type Seeded = { me: TestUser; chatId: number; postId: number };

async function seed(
  page: Page,
  apiUrl: string,
  signUp: (page: Page) => Promise<TestUser>,
  createUser: () => Promise<TestUser>,
): Promise<Seeded> {
  const me = await signUp(page);
  const other = await createUser();
  const headers = { Authorization: `Bearer ${me.session.accessToken}` };
  const post = async (path: string, data?: unknown) => {
    const response = await page.request.post(`${apiUrl}${path}`, {
      headers,
      data,
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as { id: number };
  };
  const { id: postId } = await post("/posts", {
    contentType: "text",
    content: "A post to give the feed a real row.",
  });
  const { id: chatId } = await post("/chats/direct", {
    userId: other.session.user.id,
  });
  for (let i = 1; i <= 8; i++) {
    await post(`/chats/${chatId}/messages`, {
      contentType: "text",
      content: `Message number ${i}`,
    });
  }
  return { me, chatId, postId };
}

async function expectNoSidewaysScroll(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
    timeout: 30_000,
  });
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${path} scrolls sideways`).toBeLessThanOrEqual(
    clientWidth,
  );
}

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("no main page scrolls sideways", async ({
      page,
      apiUrl,
      signUp,
      createUser,
    }) => {
      test.setTimeout(60_000);
      const { me, chatId, postId } = await seed(
        page,
        apiUrl,
        signUp,
        createUser,
      );
      for (const path of [
        "/",
        `/posts/${postId}`,
        "/chats",
        `/chats/${chatId}`,
        "/users",
        `/users/${me.session.user.id}`,
        "/notifications",
        "/search?q=message",
        "/settings",
        "/games",
      ]) {
        await expectNoSidewaysScroll(page, path);
      }
    });

    test("the top bar is one row, with search behind the menu", async ({
      page,
      signUp,
    }) => {
      await signUp(page);
      await page.goto("/");

      const nav = page.locator("[data-app-nav]");
      await expect(
        nav.getByRole("link", { name: "Notifications", exact: true }),
      ).toBeVisible();
      expect((await nav.boundingBox())!.height).toBeLessThan(80);
      await expect(nav.getByRole("searchbox")).toHaveCount(0);

      // Opened, the search box is the topmost thing at its own centre —
      // nothing (like the account name, once) is drawn over it.
      await nav.getByRole("button", { name: "Menu" }).click();
      const search = nav.getByRole("searchbox", { name: "Search" });
      await expect(search).toBeVisible();
      expect((await search.boundingBox())!.width).toBeGreaterThan(200);
      // Polled: the menu is still opening.
      await expect
        .poll(() =>
          search.evaluate((input) => {
            const box = input.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
            return hit === input;
          }),
        )
        .toBe(true);
    });

    test("an open conversation hides the site nav and shows several messages", async ({
      page,
      apiUrl,
      signUp,
      createUser,
    }) => {
      const { chatId } = await seed(page, apiUrl, signUp, createUser);
      await page.goto(`/chats/${chatId}`);
      const main = page.getByRole("main");
      await expect(main.getByText("Message number 8")).toBeVisible();

      await expect(page.locator("[data-app-nav]")).toBeHidden();
      await expect(page.locator("[data-version-tag]")).toBeHidden();
      // Room for more than a couple of bubbles, even at 412px tall.
      const thread = (await page.getByTestId("chat-scroll").boundingBox())!;
      expect(thread.height).toBeGreaterThan(180);
    });
  });
}
