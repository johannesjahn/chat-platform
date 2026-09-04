import { expect, test } from "./fixtures";
import { registerViaUi } from "./helpers";

// Seeds a couple of text posts through the API, then drives the header search
// box → results page and asserts the matching post shows up with a highlighted
// snippet, and that the result links through to the post's detail page.
test("header search finds a post and highlights the match", async ({
  page,
  request,
  apiUrl,
}) => {
  await registerViaUi(page);

  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const seed = async (content: string) => {
    const response = await request.post(`${apiUrl}/posts`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      data: { contentType: "text", content },
    });
    expect(response.ok()).toBe(true);
  };
  await seed("The peregrine falcon dives at incredible speed");
  await seed("A totally unrelated grocery list");

  // Use the unified header search box.
  await page.getByRole("searchbox", { name: "Search" }).fill("peregrine");
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");

  await expect(page).toHaveURL(/\/search\?q=peregrine/);

  // The match is highlighted (rendered as a <mark>) and the unrelated post
  // isn't shown.
  const mark = page.locator("mark", { hasText: "peregrine" });
  await expect(mark.first()).toBeVisible();
  await expect(page.getByText("grocery list")).toHaveCount(0);

  // Clicking the result opens the post detail page.
  await page.getByRole("link").filter({ hasText: "peregrine" }).first().click();
  await expect(page).toHaveURL(/\/posts\/\d+/);
  await expect(
    page.getByText("The peregrine falcon dives at incredible speed"),
  ).toBeVisible();
});

// The overhauled search matches *fragments*, not just whole words, and covers
// people alongside content — this drives both from the results page.
test("search matches a fragment inside a word and finds people", async ({
  page,
  request,
  apiUrl,
}) => {
  const { username } = await registerViaUi(page);

  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const response = await request.post(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    data: { contentType: "text", content: "notes on the fragmentary draft" },
  });
  expect(response.ok()).toBe(true);

  // "ragmenta" is a whole word nowhere — only substring matching can find it.
  await page.goto("/search?q=ragmenta");
  await expect(
    page.locator("mark", { hasText: "ragmenta" }).first(),
  ).toBeVisible();

  // People are searched too, by a fragment of the username.
  const fragment = username.slice(2, 8);
  await page.getByRole("textbox", { name: "Search query" }).fill(fragment);
  await expect(page.getByText(`@${username}`).first()).toBeVisible();

  // The People tab shows the same hit on its own.
  await page.getByRole("button", { name: "People", exact: true }).click();
  await expect(page.getByText(`@${username}`).first()).toBeVisible();
});

test("search requires a login", async ({ page }) => {
  await page.goto("/search?q=anything");
  await expect(page.getByText("Log in to search")).toBeVisible();
});
