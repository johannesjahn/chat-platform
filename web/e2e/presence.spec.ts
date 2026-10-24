import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Resolves once `page`'s `/ws` socket has delivered its first frame (the
// `presence_snapshot`), i.e. the server counts the user as online.
function socketUp(page: Page): Promise<void> {
  return new Promise((resolve) =>
    page.on("websocket", (ws) => {
      if (new URL(ws.url()).pathname !== "/ws") return;
      ws.once("framereceived", () => resolve());
    }),
  );
}

// Issue #684: presence only reaches contacts, so two online users who'd never
// shared a chat used to see each other offline after starting one, until one
// of them reconnected.
test("starting a direct chat shows the other person online without a reload", async ({
  browser,
  injectApiUrl,
  signUp,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const { username: usernameA } = await signUp(pageA);

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  const { username: usernameB } = await signUp(pageB);

  const bUp = socketUp(pageB);
  await pageB.goto("/chats");
  await bUp;

  const aUp = socketUp(pageA);
  await pageA.goto("/chats/new");
  await aUp;
  await pageA.getByRole("button", { name: "Direct message" }).click();
  await pageA.fill("#user-search", usernameB);
  await pageA.getByRole("button", { name: `@${usernameB}` }).click();
  await expect(pageA).toHaveURL(/\/chats\/\d+/);
  await pageA.fill("textarea", "hi there");
  await pageA.keyboard.press("Enter");

  // Both chat lists show the other side's dot lit, on the sockets they
  // already had.
  await expect(
    pageA
      .getByRole("link", { name: `View ${usernameB}'s profile` })
      .locator("[data-online]"),
  ).toHaveAttribute("data-online", "true");
  await expect(
    pageB
      .getByRole("link", { name: `View ${usernameA}'s profile` })
      .locator("[data-online]"),
  ).toHaveAttribute("data-online", "true");

  await contextA.close();
  await contextB.close();
});
