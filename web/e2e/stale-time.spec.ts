import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import { expect, test, type TestUser } from "./fixtures";
import { openSettled } from "./helpers";

// Issue #752: queries the realtime socket keeps current (the chat lists, the
// unread badges, each game's lobby list) and rarely-changing ones (user
// summaries) used to refetch on every mount. Leaving the feed and coming
// back should now send only the feed's own first-page refresh — while
// realtime events, a reconnect and a mount with the socket down still
// refresh them.
//
// Measured on client-side navigations from a settled page (see
// `openSettled`): a full page load also connects the socket, whose first
// connect refetches every event-driven query on purpose.

// Records every GET the page sends the backend, by path. Each `since()`
// returns a reader of what's been sent from then on.
function recordGets(page: Page, apiUrl: string) {
  const paths: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" || !request.url().startsWith(apiUrl)) return;
    paths.push(new URL(request.url()).pathname);
  });
  return () => {
    const from = paths.length;
    return () => paths.slice(from);
  };
}

const count = (paths: string[], pattern: RegExp) =>
  paths.filter((p) => pattern.test(p)).length;

const USER = /^\/users\/\d+$/;
const LOBBIES = /^\/games\/[^/]+\/lobbies$/;
const CHATS = /^\/chats$/;

function api(request: APIRequestContext, apiUrl: string, user: TestUser) {
  return async (path: string, data?: unknown) => {
    const response = await request.post(`${apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${user.session.accessToken}` },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as { id: number };
  };
}

async function seed(
  request: APIRequestContext,
  apiUrl: string,
  me: TestUser,
  other: TestUser,
) {
  await api(
    request,
    apiUrl,
    other,
  )("/posts", {
    contentType: "text",
    content: "A post to come back to",
  });
  const { id: chatId } = await api(
    request,
    apiUrl,
    me,
  )("/chats/direct", {
    userId: other.session.user.id,
  });
  await api(
    request,
    apiUrl,
    me,
  )(`/chats/${chatId}/messages`, {
    contentType: "text",
    content: "Hi!",
  });
}

const sidebarLink = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name, exact: true });

const typingRow = (page: Page) =>
  page
    .getByRole("complementary", { name: "At a glance" })
    .getByRole("link", { name: /Type Race/ });

async function goTo(page: Page, name: string, url: string) {
  await sidebarLink(page, name).click();
  await expect(page).toHaveURL(url);
}

async function toUsers(page: Page) {
  await goTo(page, "Users", "/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
}

async function toGames(page: Page) {
  await goTo(page, "Games", "/games");
  await expect(page.getByRole("heading", { name: "Arcade" })).toBeVisible();
}

async function toFeed(page: Page) {
  await goTo(page, "Feed", "/");
  await expect(page.getByText("A post to come back to")).toBeVisible();
}

// Long enough for a mount's (unwanted) refetch to show.
const settle = (page: Page) => page.waitForTimeout(750);

test("coming back to the feed doesn't refetch its rail, and lobby events still reach it", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  const me = await signUp(page);
  const other = await createUser();
  await seed(request, apiUrl, me, other);
  await openSettled(page, "/", page.getByText("A post to come back to"));
  await expect(typingRow(page)).toContainText("No open lobbies");
  const since = recordGets(page, apiUrl);

  const away = since();
  await toUsers(page);
  await toGames(page);
  await settle(page);
  // The arcade's lobby counts are the rail's, still covered.
  expect(count(away(), LOBBIES), away().join(", ")).toBe(0);

  const back = since();
  await toFeed(page);
  await settle(page);
  expect(count(back(), USER), back().join(", ")).toBe(0);
  expect(count(back(), LOBBIES), back().join(", ")).toBe(0);
  expect(count(back(), CHATS), back().join(", ")).toBe(0);
  // The feed's own first page is all it refreshes.
  expect(back()).toEqual(["/posts"]);

  // A lobby opening shows up on the feed that's open...
  await api(request, apiUrl, other)("/games/typing/lobbies");
  await expect(typingRow(page)).toContainText("1 open lobby");

  // ...and one opening while it's not is there on coming back: the rooms
  // the rail relies on outlast the page.
  await toUsers(page);
  await api(request, apiUrl, me)("/games/typing/lobbies");
  await settle(page);
  await toFeed(page);
  await expect(typingRow(page)).toContainText("2 open lobbies");
});

test("with the socket down a mount refetches, and a reconnect refreshes", async ({
  page,
  request,
  apiUrl,
  createUser,
  signUp,
}) => {
  // Every `/ws` connection goes through here, so the test can drop it.
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(
    (url) => url.pathname === "/ws",
    (ws) => {
      socket = ws;
      ws.connectToServer();
    },
  );
  const me = await signUp(page);
  const other = await createUser();
  await seed(request, apiUrl, me, other);
  await openSettled(page, "/", page.getByText("A post to come back to"));
  await expect(typingRow(page)).toContainText("No open lobbies");
  const since = recordGets(page, apiUrl);

  // Drop the socket and keep it down: no ticket, no reconnect.
  const tickets = `${apiUrl}/realtime/ws-ticket`;
  await page.route(tickets, (route) => route.fulfill({ status: 503 }));
  const dropped = socket!;
  await dropped.close();

  // Nothing pushes changes now, so a change has to be fetched...
  await api(request, apiUrl, other)("/games/typing/lobbies");
  const down = since();
  await toUsers(page);
  await toFeed(page);
  await settle(page);
  // ...and mounting with the socket down does.
  expect(count(down(), LOBBIES), down().join(", ")).toBeGreaterThan(0);
  expect(count(down(), CHATS), down().join(", ")).toBeGreaterThan(0);
  await expect(typingRow(page)).toContainText("1 open lobby");

  // Back up: the reconnect refetches what it may have missed...
  const reconnect = since();
  await page.unroute(tickets);
  await expect.poll(() => socket !== dropped, { timeout: 20_000 }).toBe(true);
  await expect.poll(() => count(reconnect(), LOBBIES)).toBeGreaterThan(0);
  await expect.poll(() => count(reconnect(), CHATS)).toBeGreaterThan(0);
  await settle(page);

  // ...and from then on, coming back to the feed reuses it again.
  const up = since();
  await toUsers(page);
  await toGames(page);
  await toFeed(page);
  await settle(page);
  expect(count(up(), LOBBIES), up().join(", ")).toBe(0);
  expect(count(up(), CHATS), up().join(", ")).toBe(0);
});
