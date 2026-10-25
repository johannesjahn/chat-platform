import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signInWithGoogle } from "./google";
import { logOut } from "./helpers";

// Issue #603: the prerendered SPA shell has no session, so until the bundle
// had downloaded and hydrated, a signed-in reader saw the signed-out nav.
// The boot script marks <html> before the first paint and the shell shows
// placeholders keyed off it.

// Reloads with every script request refused, so what's on screen is the
// shell as the boot scripts left it — React never gets to hydrate it. The
// shell's nav is the phone bar (`lg:hidden`), hence the phone viewport.
// The app's entry import fails as a result, which is the point — callers
// allow that error (see `allowConsoleErrors` in fixtures.ts).
const BLOCKED_ENTRY = /Failed to fetch dynamically imported module/;

async function reloadShellOnly(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/*", (route) =>
    route.request().resourceType() === "script"
      ? route.abort()
      : route.continue(),
  );
  await page.reload();
}

const loginLink = (page: Page) =>
  page.getByRole("navigation").getByRole("link", { name: "Log in" });

test("a signed-in reader never sees the signed-out shell before hydration", async ({
  page,
  signUp,
  allowConsoleErrors,
}) => {
  allowConsoleErrors(BLOCKED_ENTRY);
  await signUp(page);
  await reloadShellOnly(page);

  await expect(page.locator("html")).toHaveAttribute("data-session", "in");
  await expect(
    page.locator('[data-session-only="in"] [data-slot="skeleton"]:visible'),
  ).toBeVisible();
  await expect(loginLink(page)).toBeHidden();
});

test("a signed-out reader gets the signed-out shell straight away", async ({
  page,
  allowConsoleErrors,
}) => {
  allowConsoleErrors(BLOCKED_ENTRY);
  await page.goto("/");
  await reloadShellOnly(page);

  await expect(page.locator("html")).toHaveAttribute("data-session", "out");
  await expect(loginLink(page)).toBeVisible();
  await expect(page.locator('[data-session-only="in"]').first()).toBeHidden();
});

test("the session marker hydrates cleanly and follows login and logout", async ({
  page,
  signUp,
}) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });

  const user = await signUp(page);
  await expect(page.locator("html")).toHaveAttribute("data-session", "in");
  await expect(page.locator("[data-session-only]")).toHaveCount(0);

  await logOut(page);
  await expect(page.locator("html")).toHaveAttribute("data-session", "out");

  await page.goto("/login");
  await signInWithGoogle(page, user.sub);
  await expect(page).toHaveURL("/");
  await expect(page.locator("html")).toHaveAttribute("data-session", "in");

  expect(hydrationErrors).toEqual([]);
});
