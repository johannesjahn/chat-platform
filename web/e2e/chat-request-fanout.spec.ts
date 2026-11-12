import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test, type TestUser } from "./fixtures";

// Issue #749: one chat message used to cost an open viewer ~10 requests —
// the chat list, the chat detail and the message window, three times over
// (the message event, the reader's own markRead, and the server echoing
// that read receipt back). These count what the browser actually sends.

// Every API request the page sends, as "METHOD /path?query".
function recordApiRequests(page: Page, apiUrl: string) {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(apiUrl)) return;
    const url = new URL(request.url());
    // The socket's ticket and the typing pings aren't about this.
    if (url.pathname === "/realtime/ws-ticket") return;
    requests.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  return requests;
}

const auth = (user: TestUser) => ({
  Authorization: `Bearer ${user.session.accessToken}`,
});

async function sendMessage(
  request: APIRequestContext,
  apiUrl: string,
  from: TestUser,
  chatId: number,
  content: string,
) {
  const sent = await request.post(`${apiUrl}/chats/${chatId}/messages`, {
    headers: auth(from),
    data: { contentType: "text", content },
  });
  expect(sent.ok()).toBe(true);
}

// Opens the conversation and waits until it's quiet: the message is on
// screen, the realtime socket is up, and the refetches its first connect
// sets off (see realtimeSocket.ts) have come back.
async function openConversation(page: Page, chatId: number, text: string) {
  const socketUp = new Promise<void>((resolve) =>
    page.on("websocket", (ws) => ws.once("framereceived", () => resolve())),
  );
  await page.goto(`/chats/${chatId}`);
  await expect(page.getByRole("main").getByText(text)).toBeVisible();
  await socketUp;
  await page.waitForTimeout(1_000);
}

test("an incoming message in an open DM costs the viewer one fetch and one read", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const other = await createUser();
  const chat = await request.post(`${apiUrl}/chats/direct`, {
    headers: auth(me),
    data: { userId: other.session.user.id },
  });
  const { id: chatId } = await chat.json();
  await sendMessage(request, apiUrl, other, chatId, "Hello there");

  await openConversation(page, chatId, "Hello there");
  const requests = recordApiRequests(page, apiUrl);

  await sendMessage(request, apiUrl, other, chatId, "One more thing");
  await expect(
    page.getByRole("main").getByText("One more thing"),
  ).toBeVisible();
  // Long enough for any follow-up refetch (an echoed event, a second
  // markRead) to have gone out.
  await page.waitForTimeout(1_500);

  console.log(`Viewer requests for one incoming message: ${requests.length}`);
  console.log(requests.join("\n"));
  expect(
    requests.filter((r) => r.startsWith(`POST /chats/${chatId}/read`)),
  ).toHaveLength(1);
  expect(
    requests.filter((r) => r.startsWith(`GET /chats/${chatId}/messages?`)),
  ).toHaveLength(1);
  expect(requests[0]).toContain("after=");
  expect(requests).toHaveLength(2);
});

test("sending a message costs the sender the send and one fetch", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const other = await createUser();
  const chat = await request.post(`${apiUrl}/chats/direct`, {
    headers: auth(me),
    data: { userId: other.session.user.id },
  });
  const { id: chatId } = await chat.json();
  await sendMessage(request, apiUrl, me, chatId, "Earlier");

  await openConversation(page, chatId, "Earlier");
  const sent = recordApiRequests(page, apiUrl);

  await page.fill("textarea", "Fresh off the composer");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("main").getByRole("img", { name: "Sent" }),
  ).toHaveCount(2);
  await page.waitForTimeout(1_500);

  // Typing pings aren't part of what a message costs.
  const counted = sent.filter((r) => !r.endsWith("/typing"));
  console.log(`Sender requests for one sent message: ${counted.length}`);
  console.log(counted.join("\n"));
  // The send, and the echo's catch-up fetch — the list and the chat take
  // the sent message as their preview without refetching.
  expect(counted.filter((r) => r.startsWith("POST "))).toEqual([
    `POST /chats/${chatId}/messages`,
  ]);
  expect(counted.length).toBeLessThanOrEqual(2);
});

test("the sender's read receipt lands without a refetch", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const other = await createUser();
  const chat = await request.post(`${apiUrl}/chats/direct`, {
    headers: auth(me),
    data: { userId: other.session.user.id },
  });
  const { id: chatId } = await chat.json();
  await sendMessage(request, apiUrl, me, chatId, "Did you see this?");
  const sent = await request.get(`${apiUrl}/chats/${chatId}/messages`, {
    headers: auth(me),
  });
  const { messages } = await sent.json();
  const messageId = messages.at(-1).id as number;

  await openConversation(page, chatId, "Did you see this?");
  await expect(
    page.getByRole("main").getByRole("img", { name: "Sent" }),
  ).toBeVisible();
  const requests = recordApiRequests(page, apiUrl);

  const read = await request.post(`${apiUrl}/chats/${chatId}/read`, {
    headers: auth(other),
    data: { messageId },
  });
  expect(read.ok()).toBe(true);
  await expect(
    page.getByRole("main").getByRole("img", { name: "Read" }),
  ).toBeVisible();
  await page.waitForTimeout(1_500);

  console.log(`Sender requests for one read receipt: ${requests.length}`);
  console.log(requests.join("\n"));
  expect(requests).toHaveLength(0);
});

test("opening a conversation with unread messages marks it read once", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const other = await createUser();
  const chat = await request.post(`${apiUrl}/chats/direct`, {
    headers: auth(me),
    data: { userId: other.session.user.id },
  });
  const { id: chatId } = await chat.json();
  await sendMessage(request, apiUrl, other, chatId, "Unread one");
  await sendMessage(request, apiUrl, other, chatId, "Unread two");

  const requests = recordApiRequests(page, apiUrl);
  await openConversation(page, chatId, "Unread two");
  expect(
    requests.filter((r) => r.startsWith(`POST /chats/${chatId}/read`)),
  ).toHaveLength(1);

  // Then a cold load, the case the issue saw it twice on: the persisted
  // cache's window (newest: "Unread two") is shown first and replaced by a
  // fresh one while the chat still reads as unread. Leave the chat first,
  // so the next message isn't read live.
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await sendMessage(request, apiUrl, other, chatId, "Unread three");
  requests.length = 0;
  await openConversation(page, chatId, "Unread three");

  console.log(`Cold-load requests: ${requests.length}`);
  console.log(requests.join("\n"));
  expect(
    requests.filter((r) => r.startsWith(`POST /chats/${chatId}/read`)),
  ).toHaveLength(1);
});
