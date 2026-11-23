import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Issue #903: a lobby hosted by someone with a long (but valid) username
// pushed every game hub sideways on a phone, and Sketchy's waiting room put a
// spectator's Join button screens below the fold. Each test sets its own
// viewport, so neither is `@layout`.
const GAMES = [
  { slug: "typing", join: "Join the race" },
  { slug: "drawing", join: "Join the game" },
  { slug: "reflex", join: "Join the game" },
] as const;

// A host with a username at MAX_USERNAME_LENGTH (32), who opens lobbies over
// the API: the host never opens a page.
async function longNamedHost(apiUrl: string) {
  const username = `u_${randomBytes(15).toString("hex")}`;
  const password = "playwright-pw-123";
  const post = async (path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.ok, `POST ${path}`).toBe(true);
    return response.json();
  };
  await post("/users/register", { username, password });
  const { accessToken } = await post("/users/login", { username, password });
  // Creating a lobby leaves the host's previous one (which closes, being
  // empty), so a test opens each game's lobby just before it looks at it.
  const openLobby = async (game: string): Promise<{ id: number }> =>
    post(`/games/${game}/lobbies`, undefined, accessToken);
  return { username, openLobby };
}

async function expectNoSidewaysScroll(page: Page, label: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${label} scrolls sideways`).toBeLessThanOrEqual(
    clientWidth,
  );
}

test.describe("390px phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("no game page scrolls sideways with a 32-character host", async ({
    page,
    apiUrl,
    signUp,
  }) => {
    test.setTimeout(90_000);
    await signUp(page);
    const host = await longNamedHost(apiUrl);

    for (const { slug } of GAMES) {
      const lobby = await host.openLobby(slug);

      await page.goto(`/games/${slug}`);
      await expect(page.getByText(`@${host.username}'s lobby`)).toBeVisible({
        timeout: 30_000,
      });
      await expectNoSidewaysScroll(page, `/games/${slug}`);

      await page.goto(`/games/${slug}/${lobby.id}`);
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toHaveText(`@${host.username}'s lobby`, {
        timeout: 30_000,
      });
      await expectNoSidewaysScroll(page, `/games/${slug}/${lobby.id}`);
      // One line, truncated: no taller than a single line of the heading.
      const box = await heading.boundingBox();
      const lineHeight = await heading.evaluate((el) =>
        parseFloat(getComputedStyle(el).lineHeight),
      );
      expect(box!.height).toBeLessThanOrEqual(lineHeight + 1);
    }

    await page.goto("/games");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSidewaysScroll(page, "/games");
  });
});

test.describe("1280×800 desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a spectator sees Join without scrolling in every game", async ({
    page,
    apiUrl,
    signUp,
  }) => {
    test.setTimeout(90_000);
    await signUp(page);
    const host = await longNamedHost(apiUrl);

    for (const { slug, join } of GAMES) {
      const lobby = await host.openLobby(slug);
      await page.goto(`/games/${slug}/${lobby.id}`);
      const button = page.getByRole("button", { name: join });
      await expect(button).toBeVisible({ timeout: 30_000 });
      await expect(button, `${slug}: Join is below the fold`).toBeInViewport({
        ratio: 1,
      });
    }
  });
});
