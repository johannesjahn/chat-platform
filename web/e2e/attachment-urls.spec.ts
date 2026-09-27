import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { makeSolidPng, registerViaUi } from "./helpers";

// Regression tests for the "page opens, then refreshes a moment later"
// flash (issue #433): the backend re-signs every attachment's presigned S3
// URL on every read, so each background refetch used to hand every image
// already on screen a new `src` — remounting it back to its blur placeholder
// and re-downloading it. See web/src/lib/stableAttachmentUrls.ts.
//
// The e2e backend has no bucket (it serves attachments as `data:` URLs, which
// are identical on every read and so never reproduced this), so every API
// response is rewritten here to carry a freshly "signed" URL per read — a
// new `X-Amz-Date`/`X-Amz-Signature` each time, exactly like
// `S3Client.presign` — pointing at a fake bucket this test serves itself.

const BUCKET = "http://attachments.e2e.test";

// Each test boots its own backend and registers users through the UI.
test.describe.configure({ timeout: 60_000 });
const PNG = makeSolidPng(64, 48, [200, 120, 40]);

function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

// Every distinct URL the page downloaded from the fake bucket. Distinct URLs
// rather than a request count: routing a page through `page.route` disables
// the browser's HTTP cache, so a remounted `<img>` re-requests even a URL it
// already had — what matters is that no *new* URL was ever needed.
type Bucket = { urls: () => string[] };

async function simulatePresignedUrls(page: Page, apiUrl: string) {
  let signature = 0;
  const bucketUrls = new Set<string>();

  const resign = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resign);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (
      typeof record.id === "number" &&
      typeof record.url === "string" &&
      typeof record.mimeType === "string"
    ) {
      signature += 1;
      return {
        ...record,
        url: `${BUCKET}/${record.id}.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${amzDate(new Date())}&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}`,
      };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, resign(child)]),
    );
  };

  await page.route(`${apiUrl}/**`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const headers = response.headers();
    if (!(headers["content-type"] ?? "").includes("application/json")) {
      return route.fulfill({ response });
    }
    // The body changes length, so the original framing headers can't stay.
    delete headers["content-length"];
    delete headers["content-encoding"];
    return route.fulfill({
      status: response.status(),
      headers,
      json: resign(await response.json()),
    });
  });

  await page.route(`${BUCKET}/**`, (route) => {
    bucketUrls.add(route.request().url());
    return route.fulfill({ contentType: "image/png", body: PNG });
  });

  return { urls: () => [...bucketUrls] } satisfies Bucket;
}

async function uploadImage(
  request: APIRequestContext,
  apiUrl: string,
  headers: Record<string, string>,
) {
  const upload = await request.post(`${apiUrl}/attachments`, {
    headers,
    multipart: {
      file: { name: "photo.png", mimeType: "image/png", buffer: PNG },
    },
  });
  expect(upload.ok()).toBe(true);
  return (await upload.json()) as { id: number; filename: string };
}

async function authHeaders(page: Page) {
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  return { Authorization: `Bearer ${session.accessToken}` };
}

// Tags the rendered image element and starts recording every `src` change
// or (re)insertion of an attachment `<img>` from here on, so the assertions
// below can prove a refetch touched neither.
async function watchImage(page: Page) {
  const image = page.getByRole("img", { name: "photo.png" });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  await image.evaluate((el: HTMLImageElement) => {
    const w = window as unknown as { __imageChanges: string[] };
    w.__imageChanges = [];
    el.dataset.e2eMarker = "original";
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          w.__imageChanges.push(
            `src -> ${(record.target as Element).getAttribute("src")}`,
          );
        }
        for (const node of Array.from(record.addedNodes)) {
          if (
            node instanceof Element &&
            node.querySelector('img[alt="photo.png"]')
          ) {
            w.__imageChanges.push("image remounted");
          }
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  });
  return image;
}

async function imageChanges(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __imageChanges: string[] }).__imageChanges,
  );
}

// React Query refetches stale queries when the tab regains visibility —
// the same path a user switching back to the tab takes.
async function refocusTab(page: Page) {
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
  );
}

test("a feed refetch keeps attachment images as they are instead of reloading them", async ({
  page,
  request,
  apiUrl,
}) => {
  const bucket = await simulatePresignedUrls(page, apiUrl);
  await registerViaUi(page);
  const headers = await authHeaders(page);
  const attachment = await uploadImage(request, apiUrl, headers);
  const post = await request.post(`${apiUrl}/posts`, {
    headers,
    data: {
      contentType: "attachment",
      content: attachment.filename,
      attachmentId: attachment.id,
    },
  });
  expect(post.ok()).toBe(true);

  await page.goto("/");
  const image = await watchImage(page);
  const originalSrc = await image.getAttribute("src");
  expect(bucket.urls()).toEqual([originalSrc]);

  // A background refetch while staying on the page (tab refocus). The
  // response carries a newly signed URL, but the image must be untouched:
  // same element, same `src`, no second download.
  const refetched = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/posts" && res.ok(),
  );
  await refocusTab(page);
  await refetched;
  await page.waitForTimeout(500);
  expect(await imageChanges(page)).toEqual([]);
  expect(await image.getAttribute("data-e2e-marker")).toBe("original");
  expect(await image.getAttribute("src")).toBe(originalSrc);

  // The flow from the bug report: go somewhere else and come back. The feed
  // renders from cache immediately and refetches on mount; the image must
  // come back already loaded under the URL it had, not flash its blur
  // placeholder and download again once that refetch lands.
  await page.getByRole("link", { name: "Chats" }).first().click();
  await expect(page).toHaveURL("/chats");
  const remounted = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/posts" && res.ok(),
  );
  await page.getByRole("link", { name: "Chat Platform" }).first().click();
  await expect(page).toHaveURL("/");
  const back = page.getByRole("img", { name: "photo.png" });
  await expect(back).toBeVisible();
  expect(await back.getAttribute("src")).toBe(originalSrc);
  await remounted;
  await page.waitForTimeout(500);
  expect(await back.getAttribute("src")).toBe(originalSrc);
  await expect(back).toHaveClass(/opacity-100/);
  expect(bucket.urls()).toEqual([originalSrc]);
});

test("a chat refetch keeps attachment images as they are instead of reloading them", async ({
  page,
  browser,
  injectApiUrl,
  request,
  apiUrl,
}) => {
  const bucket = await simulatePresignedUrls(page, apiUrl);
  await registerViaUi(page);

  const otherContext = await browser.newContext();
  await injectApiUrl(otherContext);
  const otherPage = await otherContext.newPage();
  const { username: otherUsername } = await registerViaUi(otherPage);
  await otherContext.close();

  await page.goto("/chats/new");
  await page.getByRole("button", { name: "Direct message" }).click();
  await page.fill("#user-search", otherUsername);
  await page.getByRole("button", { name: `@${otherUsername}` }).click();
  await expect(page).toHaveURL(/\/chats\/\d+/);
  const chatId = page.url().split("/").pop();

  const headers = await authHeaders(page);
  const attachment = await uploadImage(request, apiUrl, headers);
  const message = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
    headers,
    data: {
      contentType: "attachment",
      content: attachment.filename,
      attachmentId: attachment.id,
    },
  });
  expect(message.ok()).toBe(true);

  const image = await watchImage(page);
  const originalSrc = await image.getAttribute("src");

  const isMessagesFetch = (res: { url: () => string; ok: () => boolean }) =>
    new URL(res.url()).pathname === `/chats/${chatId}/messages` && res.ok();

  // Refocusing an open chat only fetches messages *newer* than the window
  // (see useChatMessages), so existing message objects are kept as-is...
  const refetched = page.waitForResponse(isMessagesFetch);
  await refocusTab(page);
  await refetched;
  await page.waitForTimeout(500);
  expect(await imageChanges(page)).toEqual([]);
  expect(await image.getAttribute("data-e2e-marker")).toBe("original");
  expect(await image.getAttribute("src")).toBe(originalSrc);

  // ...but reopening it (chat list -> chat) renders the cached window and
  // then refetches the whole newest page, re-signing every URL in it. The
  // image must come back under the URL it already had.
  await page.getByRole("link", { name: "Chats" }).first().click();
  await expect(page).toHaveURL("/chats");
  const reopened = page.waitForResponse(isMessagesFetch);
  await page.locator(`a[href="/chats/${chatId}"]`).click();
  await expect(page).toHaveURL(`/chats/${chatId}`);
  const back = page.getByRole("img", { name: "photo.png" });
  await expect(back).toBeVisible();
  expect(await back.getAttribute("src")).toBe(originalSrc);
  await reopened;
  await page.waitForTimeout(500);
  expect(await back.getAttribute("src")).toBe(originalSrc);
  await expect(back).toHaveClass(/opacity-100/);
  expect(bucket.urls()).toEqual([originalSrc]);
});
