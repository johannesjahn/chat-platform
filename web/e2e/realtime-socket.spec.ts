import type { WebSocket } from "@playwright/test";
import { expect, test } from "./fixtures";
import { logOut } from "./helpers";

// Must match STORAGE_KEY in src/lib/auth.ts.
const SESSION_STORAGE_KEY = "chat-platform-session";

// Issue #655: the socket used to be keyed on the access token, which rotates
// on every refresh — and, since the session lives in localStorage, a refresh
// in any tab reconnected every tab (a full refetch, plus a presence blip for
// everyone else). Tab 2 stands in for "some other tab refreshed": it writes
// the rotated pair, which reaches tab 1 as a `storage` event.
test("a token refresh in another tab keeps the socket open; logging out closes it", async ({
  page,
  context,
  apiUrl,
  signUp,
}) => {
  const user = await signUp(page);

  const sockets: WebSocket[] = [];
  const firstUp = new Promise<WebSocket>((resolve) =>
    page.on("websocket", (ws) => {
      if (new URL(ws.url()).pathname !== "/ws") return;
      sockets.push(ws);
      ws.once("framereceived", () => resolve(ws));
    }),
  );
  await page.goto("/chats");
  const socket = await firstUp;
  let closed = false;
  socket.on("close", () => {
    closed = true;
  });
  let tickets = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/realtime/ws-ticket")) tickets++;
  });

  const response = await fetch(`${apiUrl}/users/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: user.session.refreshToken }),
  });
  expect(response.ok).toBe(true);
  const rotated = (await response.json()) as {
    accessToken: string;
    refreshToken: string;
  };
  expect(rotated.accessToken).not.toBe(user.session.accessToken);

  const other = await context.newPage();
  await other.goto("/");
  await other.evaluate(
    ({ key, value }) => window.localStorage.setItem(key, value),
    {
      key: SESSION_STORAGE_KEY,
      value: JSON.stringify({ ...user.session, ...rotated }),
    },
  );

  // Tab 1 picked up the new token…
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(window.localStorage.getItem(key) ?? "{}"),
        SESSION_STORAGE_KEY,
      ),
    )
    .toMatchObject({ accessToken: rotated.accessToken });
  // …and kept the socket it had. A reconnect would mint a ticket and open a
  // second socket within a frame or two of the storage event.
  await page.waitForTimeout(1_000);
  expect(tickets).toBe(0);
  expect(sockets).toHaveLength(1);
  expect(closed).toBe(false);

  await other.close();
  await logOut(page);
  await expect.poll(() => closed).toBe(true);
});
