import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// A phone's on-screen keyboard has no Shift+Enter, so on a touch device
// Enter in the chat composer inserts a newline and the send button sends
// (issue #760). With a mouse and keyboard Enter still sends. Tagged
// `@layout` so it runs on the `phone` project (Pixel 7, a coarse pointer)
// as well as the desktop ones.

async function openDirectChat(page: Page, otherUsername: string) {
  await page.goto("/chats/new");
  await page.getByRole("button", { name: "Direct message" }).click();
  await page.fill("#user-search", otherUsername);
  await page.getByRole("button", { name: `@${otherUsername}` }).click();
  await expect(page).toHaveURL(/\/chats\/\d+/);
  await expect(page.locator("textarea")).toBeVisible();
}

test(
  "Enter in the composer is a newline on touch and sends otherwise",
  { tag: "@layout" },
  async ({ page, createUser, signUp }, testInfo) => {
    await signUp(page);
    const { username } = await createUser();
    await openDirectChat(page, username);

    const textarea = page.locator("textarea");
    const touch = testInfo.project.name === "phone";
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(touch);

    await textarea.fill("first line");
    await textarea.press("Enter");

    if (touch) {
      await expect(textarea).toHaveAttribute("enterkeyhint", "enter");
      await expect(textarea).toHaveAccessibleName(
        "Write a message (Enter for a new line)",
      );
      // Nothing went out; the return became a line break.
      await expect(page.getByTestId("pending-message")).toHaveCount(0);
      await textarea.pressSequentially("second line");
      await expect(textarea).toHaveValue("first line\nsecond line");

      await page.getByRole("button", { name: "Send message" }).click();
      await expect(textarea).toHaveValue("");
      await expect(
        page.getByRole("main").getByText(/first line\s*second line/),
      ).toBeVisible();
    } else {
      await expect(textarea).toHaveAttribute("enterkeyhint", "send");
      await expect(textarea).toHaveValue("");
      await expect(
        page.getByRole("main").getByText("first line"),
      ).toBeVisible();
    }
  },
);
