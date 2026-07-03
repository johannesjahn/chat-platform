import { expect, test } from "./fixtures";

// Deliberately failing test used to verify the CI artifact upload step
// actually captures a trace/screenshot/video on failure. Remove before merging.
test("deliberately fails to exercise CI artifact upload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("this text will never appear")).toBeVisible();
});
