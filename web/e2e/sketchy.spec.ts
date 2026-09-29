import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Scribbles a zig-zag across the canvas with the mouse — Pointer Events
// under the hood, the same path a finger or pen takes.
async function scribble(page: Page): Promise<void> {
  const canvas = page.getByRole("img", { name: "Your drawing" });
  await expect(canvas).toBeVisible();
  // Raw mouse coordinates only land if the canvas is on screen — and the
  // page may still be scrolled down from the waiting room (e.g. to the
  // lobby chat below the game).
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      box.x + box.width * (0.2 + i * 0.07),
      box.y + box.height * (i % 2 === 0 ? 0.3 : 0.7),
      { steps: 4 },
    );
  }
  await page.mouse.up();
}

type Seat = { page: Page; name: string };

// One drawing's turn in the spotlight: everyone but its artist bluffs, then
// votes, then the reveal plays out. Returns once the truth has landed.
async function playSpotlight(seats: Seat[], turn: number): Promise<void> {
  // Exactly one of the three is told the drawing is theirs.
  let artistIndex = -1;
  await expect
    .poll(
      async () => {
        artistIndex = -1;
        for (const [index, { page }] of seats.entries()) {
          if (await page.getByText("This one's yours!").isVisible()) {
            artistIndex = index;
          }
        }
        return artistIndex;
      },
      { timeout: 20_000 },
    )
    .not.toBe(-1);
  const guessers = seats.filter((_, index) => index !== artistIndex);

  for (const { page, name } of guessers) {
    const field = page.getByLabel("What is this?");
    await expect(field).toBeVisible();
    await field.fill(`an invented title by ${name} for ${turn}`);
    await page.getByRole("button", { name: "Submit bluff" }).click();
  }

  for (const { page } of guessers) {
    await expect(
      page.getByRole("heading", { name: "Which one is the real title?" }),
    ).toBeVisible({ timeout: 10_000 });
    // Two bluffs plus the truth are on the ballot; your own is locked.
    const answers = page
      .getByRole("list", { name: "Answers" })
      .getByRole("button");
    await expect(answers).toHaveCount(3);
    await answers.and(page.locator(":enabled")).first().click();
  }

  // Everyone sees the same reveal, the truth stamped last.
  for (const { page } of seats) {
    await expect(
      page
        .getByRole("list", { name: "Reveal" })
        .getByText("Truth", { exact: true }),
    ).toBeVisible({ timeout: 25_000 });
  }
}

test("three players play a full round of Sketchy: draw → bluff → vote → reveal → results", async ({
  browser,
  injectApiUrl,
  signUp,
}) => {
  test.setTimeout(180_000);

  const seats: Seat[] = [];
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext();
    await injectApiUrl(context);
    const page = await context.newPage();
    const user = await signUp(page);
    seats.push({ page, name: user.username });
  }
  const [host, ...guests] = seats;

  // The host opens a lobby from the arcade.
  await host!.page.getByRole("link", { name: "Games" }).click();
  await host!.page.getByRole("link", { name: /Sketchy/ }).click();
  await host!.page.getByRole("button", { name: "New lobby" }).click();
  await expect(host!.page.getByText("Waiting room")).toBeVisible();
  const lobbyPath = new URL(host!.page.url()).pathname;

  // Two players can't start a bluffing game.
  const start = host!.page.getByRole("button", { name: "Start game" });
  await expect(start).toBeDisabled();

  for (const guest of guests) {
    await guest.page.goto(lobbyPath);
    await guest.page.getByRole("button", { name: "Join the game" }).click();
  }

  // The host adds a pack; the guests see it selected live.
  await host!.page.getByRole("button", { name: /Animals/ }).click();
  for (const guest of guests) {
    await expect(
      guest.page.getByRole("button", { name: /Animals/ }),
    ).toHaveAttribute("aria-pressed", "true");
  }

  await expect(start).toBeEnabled();
  await start.click();

  // --- Draw: everyone gets their own secret prompt. ---------------------
  const prompts = await Promise.all(
    seats.map(async ({ page }) => {
      const prompt = page.locator("[data-prompt]");
      await expect(prompt).toBeVisible({ timeout: 15_000 });
      return (await prompt.textContent()) ?? "";
    }),
  );
  expect(new Set(prompts).size).toBe(3);
  for (const { page } of seats) {
    await scribble(page);
    const done = page.getByRole("button", { name: "I'm done" });
    await done.click();
    // Sent — the last one in skips straight on to the first bluff.
    await expect(done).toBeHidden();
  }

  // --- Each drawing takes its turn in the spotlight. ----------------------
  for (let turn = 0; turn < 3; turn++) {
    await playSpotlight(seats, turn);
  }

  // --- Results: the podium, the gallery, and the host's rematch. ---------
  for (const { page } of seats) {
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: "Gallery" })).toBeVisible();
    // Every prompt is on the gallery wall now.
    for (const prompt of prompts) {
      await expect(
        page.getByRole("img", { name: prompt, exact: true }),
      ).toBeVisible();
    }
  }
  await expect(
    host!.page.getByRole("button", { name: "Rematch" }),
  ).toBeVisible();

  for (const { page } of seats) await page.context().close();
});
