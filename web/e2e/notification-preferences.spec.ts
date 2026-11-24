import { expect, test } from "./fixtures";

// Per-type notification preferences (issue #900).

test("a notification type turned off in settings stays off", async ({
  page,
  signUp,
}) => {
  await signUp(page);
  await page.goto("/settings?section=notifications");
  const reactions = page.getByRole("checkbox", { name: "Reactions" });
  await expect(reactions).toBeChecked();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/notifications/preferences") &&
      response.request().method() === "PATCH",
  );
  await reactions.focus();
  await page.keyboard.press("Space");
  await expect(reactions).not.toBeChecked();
  await saved;
  await expect(reactions).toBeFocused();

  await page.reload();
  await expect(reactions).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Mentions" })).toBeChecked();
});
