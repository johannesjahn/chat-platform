import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";

// Optimistic sends (lib/outbox.ts): a message appears in the thread the moment
// it's sent, as a "sending" bubble, and the composer is free again straight
// away — the request finishes in the background.

async function openDirectChat(page: Page, otherUsername: string) {
  await page.goto("/chats/new");
  await page.getByRole("button", { name: "Direct message" }).click();
  await page.fill("#user-search", otherUsername);
  await page.getByRole("button", { name: `@${otherUsername}` }).click();
  await expect(page).toHaveURL(/\/chats\/\d+/);
  await expect(page.locator("textarea")).toBeVisible();
}

const isSend = (route: Route) => route.request().method() === "POST";

test("a sent message shows at once and the composer is free while the request is still out", async ({
  page,
  createUser,
  signUp,
}) => {
  await signUp(page);
  const { username } = await createUser();
  await openDirectChat(page, username);

  // Hold every send until the test lets them through.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let sendsSeen = 0;
  await page.route("**/chats/*/messages", async (route) => {
    if (!isSend(route)) return route.fallback();
    sendsSeen++;
    await released;
    await route.continue();
  });

  const main = page.getByRole("main");
  const pending = page.getByTestId("pending-message");

  await page.fill("textarea", "First, sent optimistically");
  await page.keyboard.press("Enter");
  await expect(pending).toHaveAttribute("data-status", "sending");
  await expect(main.getByText("First, sent optimistically")).toBeVisible();
  await expect(main.getByRole("img", { name: "Sending" })).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue("");

  // A second message can go straight away, without waiting on the first.
  await page.fill("textarea", "Second, right behind it");
  await page.keyboard.press("Enter");
  await expect(pending).toHaveCount(2);
  await expect(main.getByText("Second, right behind it")).toBeVisible();
  // …but only goes over the wire once the first is done, so the two can't
  // swap places on the server.
  expect(sendsSeen).toBe(1);

  release();

  await expect(pending).toHaveCount(0);
  await expect(main.getByRole("img", { name: "Sent" })).toHaveCount(2);
  const first = main.getByText("First, sent optimistically");
  const second = main.getByText("Second, right behind it");
  await expect(first).toHaveCount(1);
  await expect(second).toHaveCount(1);
  const firstBox = (await first.boundingBox())!;
  const secondBox = (await second.boundingBox())!;
  expect(firstBox.y).toBeLessThan(secondBox.y);
});

test("a send the server rejects can be retried or discarded", async ({
  page,
  createUser,
  signUp,
}) => {
  await signUp(page);
  const { username } = await createUser();
  await openDirectChat(page, username);

  await page.route("**/chats/*/messages", (route) =>
    isSend(route)
      ? route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            _tag: "Forbidden",
            message: "rejected for this test",
          }),
        })
      : route.fallback(),
  );

  const main = page.getByRole("main");
  await page.fill("textarea", "Rejected, then retried");
  await page.keyboard.press("Enter");
  await page.fill("textarea", "Rejected, then discarded");
  await page.keyboard.press("Enter");

  await expect(
    page.locator('[data-testid="pending-message"][data-status="failed"]'),
  ).toHaveCount(2);
  await expect(main.getByText("Failed to send")).toHaveCount(2);

  await page.unroute("**/chats/*/messages");

  const discarded = page
    .getByTestId("pending-message")
    .filter({ hasText: "Rejected, then discarded" });
  await discarded.getByRole("button", { name: "Discard message" }).click();
  await expect(discarded).toHaveCount(0);

  await page
    .getByTestId("pending-message")
    .filter({ hasText: "Rejected, then retried" })
    .getByRole("button", { name: "Retry sending message" })
    .click();
  await expect(page.getByTestId("pending-message")).toHaveCount(0);
  await expect(main.getByText("Rejected, then retried")).toHaveCount(1);
  await expect(main.getByText("Rejected, then discarded")).toHaveCount(0);

  // It really was stored: still there after a reload.
  await page.reload();
  await expect(main.getByText("Rejected, then retried")).toBeVisible();
});

test("the realtime refetch beating the send's own response never shows the message twice", async ({
  page,
  createUser,
  signUp,
}) => {
  await signUp(page);
  const { username } = await createUser();
  await openDirectChat(page, username);

  // Let the server store the message (and push `chat_updated`, which makes the
  // client refetch it) but hold its response back, so the refetched message
  // arrives while the "sending" bubble is still up.
  let responded = false;
  await page.route("**/chats/*/messages", async (route) => {
    if (!isSend(route)) return route.fallback();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({ response });
    responded = true;
  });

  const main = page.getByRole("main");
  const text = "Arrives twice, shown once";
  await page.fill("textarea", text);
  await page.keyboard.press("Enter");

  // The refetch brings in the real message (with its read-receipt tick)
  // before the response does — and the bubble steps aside for it.
  await expect(main.getByRole("img", { name: "Sent" })).toBeVisible();
  expect(responded).toBe(false);
  await expect(page.getByTestId("pending-message")).toHaveCount(0);
  await expect(main.getByText(text)).toHaveCount(1);

  // Still exactly one once the held response lands too.
  await expect.poll(() => responded).toBe(true);
  await expect(main.getByText(text)).toHaveCount(1);
});
