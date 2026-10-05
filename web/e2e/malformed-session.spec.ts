import { expect, test } from "./fixtures";

// Issue #508: unparseable (or structurally invalid) session data in
// localStorage used to throw during render, so the app never loaded until
// storage was cleared by hand. It must read as signed out and be removed.
for (const [name, stored] of [
  ["unparseable JSON", "{oops"],
  ["valid JSON of the wrong shape", JSON.stringify({ token: "old-format" })],
] as const) {
  test(`malformed session data (${name}) reads as signed out and is removed`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(
      (value) => localStorage.setItem("chat-platform-session", value),
      stored,
    );
    await page.reload();

    await expect(
      page.getByRole("navigation").getByRole("link", { name: "Log in" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("chat-platform-session")),
      )
      .toBeNull();
  });
}
