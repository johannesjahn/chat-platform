import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";

// A unique username per run so repeated runs never collide on the (unique)
// username column. base64url keeps it to URL-safe, schema-valid characters.
export function randomUsername(): string {
  return `u_${randomBytes(9).toString("base64url")}`;
}

// Registers a new user through the UI (which auto-logs them in) and returns
// the credentials, so callers can act as this user or log back in as them
// from a different browser context.
export async function registerViaUi(
  page: Page,
): Promise<{ username: string; password: string }> {
  const username = randomUsername();
  const password = "playwright-pw-123";

  await page.goto("/register");
  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Register" }).click();
  await page.waitForURL("/");

  return { username, password };
}
