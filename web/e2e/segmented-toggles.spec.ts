import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// The "pick one" button rows (post type, search filters, DM/group) show the
// active option by colour alone, so each must also expose it to assistive
// tech: a labelled group of toggle buttons with `aria-pressed` (#525).
async function expectSelected(
  page: Page,
  group: string,
  options: string[],
  selected: string,
) {
  const toggles = page.getByRole("group", { name: group });
  for (const option of options) {
    await expect(
      toggles.getByRole("button", { name: option, exact: true }),
    ).toHaveAttribute("aria-pressed", String(option === selected));
  }
}

test("segmented toggles expose the selected option to screen readers", async ({
  page,
  signUp,
}) => {
  await signUp(page);

  const postTypes = ["Text", "Image URL", "File"];
  await page.goto("/posts/new");
  await expectSelected(page, "Post type", postTypes, "Text");
  await page.getByRole("button", { name: "Image URL", exact: true }).click();
  await expectSelected(page, "Post type", postTypes, "Image URL");

  const filters = ["All", "People", "Posts", "Comments", "Messages"];
  await page.goto("/search?q=lorem");
  await expectSelected(page, "Filter results", filters, "All");
  await page.getByRole("button", { name: "People", exact: true }).click();
  await expectSelected(page, "Filter results", filters, "People");

  const chatTypes = ["Direct message", "Group chat"];
  await page.goto("/chats/new");
  await expectSelected(page, "Chat type", chatTypes, "Direct message");
  await page.getByRole("button", { name: "Group chat", exact: true }).click();
  await expectSelected(page, "Chat type", chatTypes, "Group chat");
});
