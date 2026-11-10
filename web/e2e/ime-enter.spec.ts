import type { Page } from "@playwright/test";
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

// Dispatches an IME-confirming Enter keydown on the composer; resolves to
// whether anything called preventDefault on it.
function dispatchImeEnter(
  page: Page,
  { isComposing, keyCode }: { isComposing: boolean; keyCode: number },
): Promise<boolean> {
  return page.locator("textarea").evaluate(
    (el, { isComposing, keyCode }) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "keyCode", { value: keyCode });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { isComposing, keyCode },
  );
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
