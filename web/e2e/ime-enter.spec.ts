import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// With an IME (Japanese, Chinese, Korean, …) Enter first confirms the
// composed text; that Enter must never send the half-typed message
// (issue #759). Playwright can't drive a real IME, so the keydown a browser
// fires for the confirming Enter is dispatched by hand: `isComposing: true`
// (Chrome, Firefox) or `isComposing: false` with keyCode 229 (Safari).

async function openDirectChat(page: Page, otherUsername: string) {
  await page.goto("/chats/new");
  await page.getByRole("button", { name: "Direct message" }).click();
  await page.fill("#user-search", otherUsername);
  await page.getByRole("button", { name: `@${otherUsername}` }).click();
  await expect(page).toHaveURL(/\/chats\/\d+/);
  await expect(page.locator("textarea")).toBeVisible();
}

type ImeKey = {
  key?: "Enter" | "Tab";
  isComposing: boolean;
  keyCode: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

// Dispatches an IME-confirming keydown (Enter unless `key` says otherwise)
// on `target`, the composer by default; resolves to whether anything called
// preventDefault on it.
function dispatchImeEnter(
  page: Page,
  options: ImeKey,
  target: Locator = page.locator("textarea"),
): Promise<boolean> {
  return target.evaluate((el, { key = "Enter", keyCode, ...init }) => {
    const event = new KeyboardEvent("keydown", {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    Object.defineProperty(event, "keyCode", { value: keyCode });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, options);
}

// The two shapes of an IME-confirming key press: Chrome/Firefox, then
// Safari (says it isn't composing, but is keyCode 229).
const imeVariants = (extra: Partial<ImeKey> = {}): ReadonlyArray<ImeKey> => [
  { isComposing: true, keyCode: 13, ...extra },
  { isComposing: false, keyCode: 229, ...extra },
];

async function expectIgnored(
  page: Page,
  target: Locator,
  extra: Partial<ImeKey> = {},
) {
  for (const variant of imeVariants(extra)) {
    expect(await dispatchImeEnter(page, variant, target)).toBe(false);
  }
}

test("Enter confirming an IME composition doesn't send the message", async ({
  page,
  createUser,
  signUp,
}) => {
  await signUp(page);
  const { username } = await createUser();
  await openDirectChat(page, username);

  let sends = 0;
  await page.route("**/chats/*/messages", (route) => {
    if (route.request().method() === "POST") sends++;
    return route.fallback();
  });

  const textarea = page.locator("textarea");
  await textarea.fill("にほんご");

  expect(await dispatchImeEnter(page, { isComposing: true, keyCode: 13 })).toBe(
    false,
  );
  // Safari: the confirming keydown says it isn't composing, but is keyCode 229.
  expect(
    await dispatchImeEnter(page, { isComposing: false, keyCode: 229 }),
  ).toBe(false);

  await expect(textarea).toHaveValue("にほんご");
  await expect(page.getByTestId("pending-message")).toHaveCount(0);
  expect(sends).toBe(0);

  // Once the composition is done, a plain Enter still sends.
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("");
  await expect(page.getByRole("main").getByText("にほんご")).toBeVisible();
  expect(sends).toBe(1);
});

test("Enter confirming an IME composition doesn't save a message edit", async ({
  page,
  createUser,
  signUp,
}) => {
  await signUp(page);
  const { username } = await createUser();
  await openDirectChat(page, username);
  const composer = page.locator("textarea");
  await composer.fill("first draft");
  await composer.press("Enter");
  await expect(page.getByRole("main").getByText("first draft")).toBeVisible();
  // Only a confirmed message can be edited.
  await expect(page.getByTestId("pending-message")).toHaveCount(0);

  let edits = 0;
  await page.route("**/chats/*/messages/*", (route) => {
    if (route.request().method() === "PUT") edits++;
    return route.fallback();
  });

  // ↑ in the empty composer edits the newest message.
  await composer.press("ArrowUp");
  const save = page.getByRole("button", { name: "Save edit" });
  await expect(save).toBeVisible();
  const editor = page.locator("textarea:focus");
  await editor.fill("にほんご");

  await expectIgnored(page, editor);
  await expect(save).toBeVisible();
  await expect(editor).toHaveValue("にほんご");
  expect(edits).toBe(0);

  await editor.press("Enter");
  await expect(save).toHaveCount(0);
  await expect(page.getByRole("main").getByText("にほんご")).toBeVisible();
  expect(edits).toBe(1);
});

test("Enter or Tab confirming an IME composition doesn't pick an @mention suggestion", async ({
  page,
  createUser,
  signUp,
}) => {
  const { username: mentioned } = await createUser();
  await signUp(page);
  await page.goto("/posts/new");
  await page.getByRole("button", { name: "Text" }).click();
  const composer = page.locator("#content");
  const typed = `Hi @${mentioned.slice(0, 8)}`;
  await composer.pressSequentially(typed);
  const suggestion = page.getByRole("option", { name: `@${mentioned}` });
  await expect(suggestion).toBeVisible();

  await expectIgnored(page, composer);
  await expectIgnored(page, composer, { key: "Tab" });
  await expect(suggestion).toBeVisible();
  await expect(composer).toHaveValue(typed);

  await composer.press("Enter");
  await expect(composer).toHaveValue(`Hi @${mentioned} `);
});

test("Enter confirming an IME composition doesn't open a palette result or start a search", async ({
  page,
  createUser,
  signUp,
}) => {
  await signUp(page);
  const { username } = await createUser();
  await page.goto("/");
  await expect(
    page.getByRole("textbox", { name: "Write a post" }),
  ).toBeVisible();

  // The switcher: Enter would open the highlighted match.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", {
    name: "Search and quick switcher",
  });
  const box = palette.getByRole("combobox");
  await box.fill(username);
  await expect(
    palette.getByRole("option", { name: `@${username}` }),
  ).toBeVisible();
  await expectIgnored(page, box);
  await expect(palette).toBeVisible();
  await expect(page).toHaveURL("/");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // Search mode: Enter would go to the full results.
  await page.keyboard.press("/");
  await expect(box).toBeFocused();
  await box.fill("ふぁるこん");
  await expectIgnored(page, box);
  await expect(palette).toBeVisible();
  await expect(page).toHaveURL("/");

  await box.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=/);
});

test("Cmd/Ctrl+Enter confirming an IME composition doesn't post from the inline composer", async ({
  page,
  signUp,
}) => {
  await signUp(page);
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Write a post" });
  await composer.click();
  await composer.fill("にほんご");

  let posts = 0;
  await page.route("**/posts", (route) => {
    if (route.request().method() === "POST") posts++;
    return route.fallback();
  });

  await expectIgnored(page, composer, { ctrlKey: true, metaKey: true });
  await expect(composer).toHaveValue("にほんご");
  expect(posts).toBe(0);

  await composer.press("ControlOrMeta+Enter");
  await expect(
    page.locator("[data-post-id]").getByText("にほんご"),
  ).toBeVisible();
  expect(posts).toBe(1);
});
