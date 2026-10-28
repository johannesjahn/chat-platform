import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Every main page is scanned with axe-core, the engine behind Lighthouse's
// accessibility score, so a missing label, a contrast regression or broken
// ARIA fails the build here instead of drifting a Lighthouse number (the
// `lighthouse` CI job only reports). Tagged `@layout`, so the phone and wide
// layouts are scanned too, and every page is scanned in both themes. Each
// scan is a soft assertion: one run lists every violation, not just the
// first.

const COLOR_SCHEMES = ["light", "dark"] as const;

// WCAG 2.x A and AA — what Lighthouse's accessibility category checks, minus
// axe's opinionated "best-practice" rules.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Flipping the theme starts every `transition-colors` at once, and a page's
// entrance animations may still be running; axe measuring contrast part-way
// through reads a blend of two states. Like Playwright's screenshot
// `animations: "disabled"`, jump everything to its end state instead
// (reduced motion alone doesn't stop plain transitions).
const FREEZE_MOTION = `*, *::before, *::after {
  transition: none !important;
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
}`;

async function expectAccessible(page: Page, name: string): Promise<void> {
  await test.step(`axe: ${name}`, async () => {
    // Every page has an <h1> (issue #498); wait for it so the scan sees the
    // page, not its loading state. Generous, since this is also the wait for
    // the dev server's first compile of each route.
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.addStyleTag({ content: FREEZE_MOTION });
    for (const colorScheme of COLOR_SCHEMES) {
      await page.emulateMedia({ colorScheme });
      const { violations } = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .analyze();
      const report = violations.map(
        ({ id, impact, help, helpUrl, nodes }) =>
          `[${impact}] ${id}: ${help} (${helpUrl})\n${nodes
            .slice(0, 5)
            .map((node) => `    ${node.target.join(" ")}\n      ${node.html}`)
            .join("\n")}`,
      );
      expect
        .soft(report, `accessibility violations on ${name} (${colorScheme})`)
        .toEqual([]);
    }
  });
}

test(
  "signed-out pages have no accessibility violations",
  { tag: "@layout" },
  async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto("/login");
    await expectAccessible(page, "/login");

    await page.goto("/register");
    await expectAccessible(page, "/register");
  },
);

test(
  "signed-in pages have no accessibility violations",
  { tag: "@layout" },
  async ({ page, request, apiUrl, signUp, createUser }) => {
    test.setTimeout(120_000);

    const me = await signUp(page);
    const other = await createUser();
    const headers = { Authorization: `Bearer ${me.session.accessToken}` };
    const post = async (path: string, data?: unknown) => {
      const response = await request.post(`${apiUrl}${path}`, {
        headers,
        data,
      });
      expect(response.ok()).toBe(true);
      return (await response.json()) as { id: number };
    };

    // Enough content that each page renders its real rows, not an empty state.
    const { id: postId } = await post("/posts", {
      contentType: "text",
      content: "Accessibility check\n\nA post with a comment under it.",
    });
    await post(`/posts/${postId}/comments`, { content: "A first comment." });
    const { id: chatId } = await post("/chats/direct", {
      userId: other.session.user.id,
    });
    await post(`/chats/${chatId}/messages`, {
      contentType: "text",
      content: "Hello there!",
    });
    const { id: lobbyId } = await post("/games/typing/lobbies");

    const pages = [
      "/",
      `/posts/${postId}`,
      "/posts/new",
      `/users/${me.session.user.id}`,
      "/users",
      "/chats",
      `/chats/${chatId}`,
      "/notifications",
      "/search?q=accessibility",
      "/settings",
      "/games",
      "/games/typing",
      `/games/typing/${lobbyId}`,
    ];
    for (const path of pages) {
      await page.goto(path);
      await expectAccessible(page, path);
    }
  },
);
