import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test, type TestUser } from "./fixtures";

// Issue #764: below the directory search's 3-character floor (issue #48),
// the New chat picker, /users and the palette's People section suggest the
// people you already share a chat with — never anyone else.

const as = (user: TestUser) => ({
  Authorization: `Bearer ${user.session.accessToken}`,
});

async function named(
  request: APIRequestContext,
  apiUrl: string,
  user: TestUser,
  displayName: string,
) {
  const response = await request.put(`${apiUrl}/users/me`, {
    headers: as(user),
    data: { displayName, avatarUrl: null },
  });
  expect(response.ok()).toBe(true);
}

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

// Me, two contacts — Zara (an older chat) and Yusuf (the newest) — and a
// stranger whose name would match the same fragment as Zara's.
async function seed(
  page: Page,
  request: APIRequestContext,
  apiUrl: string,
  signUp: (page: Page) => Promise<TestUser>,
  createUser: () => Promise<TestUser>,
) {
  const me = await signUp(page);
  const zara = await createUser();
  const yusuf = await createUser();
  const stranger = await createUser();
  await named(request, apiUrl, zara, "Zara Quill");
  await named(request, apiUrl, yusuf, "Yusuf Brandt");
  await named(request, apiUrl, stranger, "Quinn Stranger");
  const zaraChat = await directChat(request, apiUrl, me, zara);
  const yusufChat = await directChat(request, apiUrl, me, yusuf);
  // A message makes Yusuf's chat the most recent beyond any doubt.
  const sent = await request.post(`${apiUrl}/chats/${yusufChat}/messages`, {
    headers: as(me),
    data: { contentType: "text", content: "hi" },
  });
  expect(sent.ok()).toBe(true);
  return { me, zara, yusuf, stranger, zaraChat, yusufChat };
}

test(
  "New chat suggests recent contacts before typing; picking one opens the DM",
  { tag: "@layout" },
  async ({ page, request, apiUrl, signUp, createUser }) => {
    const { zaraChat } = await seed(page, request, apiUrl, signUp, createUser);

    await page.goto("/chats/new");
    const main = page.getByRole("main");
    const contacts = main.getByRole("list", { name: "Recent contacts" });
    // Most recent first, and nobody you haven't chatted with.
    await expect(contacts.getByRole("button")).toHaveText([
      /Yusuf Brandt/,
      /Zara Quill/,
    ]);
    await expect(main.getByText("Quinn Stranger")).toHaveCount(0);

    // Group: picking a contact adds them to the selection.
    await main.getByRole("button", { name: "Group chat" }).click();
    const zara = contacts.getByRole("button", { name: /Zara Quill/ });
    await zara.click();
    await expect(zara).toHaveAttribute("aria-pressed", "true");
    await expect(main.getByText(/^1\/\d+ selected$/)).toBeVisible();

    // Direct: 1–2 characters filter the contacts, and picking one opens
    // the existing DM.
    await main.getByRole("button", { name: "Direct message" }).click();
    await main.getByLabel("Message", { exact: true }).fill("qu");
    const matching = main.getByRole("list", { name: "Matching contacts" });
    await expect(matching.getByRole("button")).toHaveText([/Zara Quill/]);
    await expect(main.getByText("Quinn Stranger")).toHaveCount(0);
    await matching.getByRole("button", { name: /Zara Quill/ }).click();
    await expect(page).toHaveURL(`/chats/${zaraChat}`);
  },
);

test(
  "/users shows your contacts, and 2 characters filter them",
  { tag: "@layout" },
  async ({ page, request, apiUrl, signUp, createUser }) => {
    await seed(page, request, apiUrl, signUp, createUser);

    await page.goto("/users");
    const main = page.getByRole("main");
    const contacts = main.getByRole("list", { name: "Your contacts" });
    await expect(contacts.getByRole("link")).toHaveText([
      /Yusuf Brandt/,
      /Zara Quill/,
    ]);
    await expect(main.getByText(/characters to search everyone/)).toBeVisible();

    await main.getByPlaceholder("Search users…").fill("qu");
    const matching = main.getByRole("list", { name: "Matching contacts" });
    await expect(matching.getByRole("link")).toHaveText([/Zara Quill/]);
    await expect(main.getByText("Quinn Stranger")).toHaveCount(0);

    await main.getByPlaceholder("Search users…").fill("zz");
    await expect(main.getByText(/None of your contacts match/)).toBeVisible();
    await expect(main.getByRole("list")).toHaveCount(0);
  },
);

test("the /users hint lines up with the search box", async ({
  page,
  signUp,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page);
  await page.goto("/users");
  const main = page.getByRole("main");
  const box = await main.getByPlaceholder("Search users…").boundingBox();
  const hint = await main.getByText(/Type at least 3 characters/).boundingBox();
  expect(box).not.toBeNull();
  expect(hint).not.toBeNull();
  const centre = (b: { x: number; width: number }) => b.x + b.width / 2;
  expect(Math.abs(centre(hint!) - centre(box!))).toBeLessThan(2);
});

test("the palette's People section draws on your contacts for 1–2 characters", async ({
  page,
  request,
  apiUrl,
  signUp,
  createUser,
}) => {
  const { zara, yusuf } = await seed(page, request, apiUrl, signUp, createUser);

  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", {
    name: "Search and quick switcher",
  });
  const box = palette.getByRole("combobox");
  await expect(box).toBeFocused();

  // A People row carries the handle; the matching chat row above it doesn't.
  const person = (user: TestUser) =>
    palette.getByRole("option").filter({ hasText: `@${user.username}` });

  await box.fill("q");
  await expect(person(zara)).toHaveCount(1);
  await expect(person(yusuf)).toHaveCount(0);
  await box.fill("bR");
  await expect(person(yusuf)).toHaveCount(1);
  await expect(person(zara)).toHaveCount(0);
  await expect(palette.getByText("Quinn Stranger")).toHaveCount(0);

  await person(yusuf).click();
  await expect(page).toHaveURL(`/users/${yusuf.session.user.id}`);
});
