import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { registerViaUi } from "./helpers";

// The passage is rendered one span per character inside an aria-hidden
// container (input goes through a transparent field laid over it — see
// TypingPassage.tsx), so its text content is exactly the passage.
async function readPassage(page: Page): Promise<string> {
  const passage = page.locator("[data-passage]");
  await expect(passage).toBeVisible();
  return (await passage.textContent()) ?? "";
}

// Types like a (fast) human. The server rejects a finish faster than 250 WPM
// as implausible (MAX_PLAUSIBLE_WPM in src/games/typing.ts), so this has to
// actually take a while — ~75ms a character is ~160 WPM.
async function typePassage(page: Page, text: string): Promise<void> {
  const input = page.getByLabel("Type the passage");
  await expect(input).toBeEnabled({ timeout: 10_000 });
  await input.pressSequentially(text, { delay: 75 });
}

test("two players race live and both land on the results podium", async ({
  browser,
  injectApiUrl,
}) => {
  test.setTimeout(120_000);

  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const alice = await registerViaUi(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const bob = await registerViaUi(pageB);

  // Alice opens a lobby from the arcade.
  await pageA.getByRole("link", { name: "Games" }).click();
  await pageA.getByRole("link", { name: /Type Race/ }).click();
  await pageA.getByRole("button", { name: "New lobby" }).click();
  await expect(pageA.getByText("Waiting room")).toBeVisible();
  const lobbyUrl = pageA.url();

  // Bob follows the invite link and sits down; Alice sees his seat fill
  // live, without reloading.
  await pageB.goto(new URL(lobbyUrl).pathname);
  await pageB.getByRole("button", { name: "Join the race" }).click();
  await expect(pageB.getByText(/Waiting for .* to start/)).toBeVisible();
  await expect(pageA.getByText(`@${bob.username}`)).toBeVisible();

  await pageA.getByRole("button", { name: "Start race" }).click();

  const [passageA, passageB] = await Promise.all([
    readPassage(pageA),
    readPassage(pageB),
  ]);
  expect(passageA.length).toBeGreaterThan(50);
  expect(passageB).toBe(passageA);

  // Alice types; Bob watches her lane move before either of them finishes.
  const aliceTyping = typePassage(pageA, passageA);
  await expect
    .poll(
      async () =>
        Number(
          await pageB
            .getByRole("progressbar", { name: `@${alice.username}'s progress` })
            .getAttribute("aria-valuenow"),
        ),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  await Promise.all([aliceTyping, typePassage(pageB, passageA)]);

  for (const page of [pageA, pageB]) {
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible({
      timeout: 15_000,
    });
  }
  // The host gets the rematch button; the guest waits for it.
  await expect(pageA.getByRole("button", { name: "Rematch" })).toBeVisible();
  await expect(pageB.getByText("Waiting for a rematch")).toBeVisible();

  // Both results are on the leaderboard.
  await pageA.getByRole("link", { name: "See the leaderboard" }).click();
  const board = pageA.getByRole("list").filter({ hasText: "WPM" }).first();
  await expect(board.getByText(`@${alice.username}`)).toBeVisible();
  await expect(board.getByText(`@${bob.username}`)).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test("a signed-out visitor is asked to log in before playing", async ({
  page,
}) => {
  await page.goto("/games");
  await expect(page.getByText("Log in to play")).toBeVisible();
});
