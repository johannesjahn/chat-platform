import type { BrowserContext, Page } from "@playwright/test";
import { test as base } from "@playwright/test";
import type { components } from "../src/lib/api-types";
import { startTestBackend } from "./backend";
import { randomUsername } from "./helpers";

type Session = components["schemas"]["LoginResponse"];

type InjectApiUrl = (context: BrowserContext) => Promise<void>;

export type TestUser = {
  username: string;
  password: string;
  session: Session;
};

// Must match STORAGE_KEY in src/lib/auth.ts.
const SESSION_STORAGE_KEY = "chat-platform-session";

const TEST_PASSWORD = "playwright-pw-123";

async function postJson(url: string, body: unknown): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `POST ${url} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

// Extends Playwright's `test` with an `apiUrl` fixture: a dedicated backend
// process + SQLite file, started fresh for every test and torn down after.
// The default `context` fixture is overridden to point the frontend at it
// (see `injectApiUrl` below) — tests that create their own extra contexts
// (e.g. to simulate two separate users) must call `injectApiUrl` themselves
// before creating pages from those contexts.
//
// Test users are created over the API rather than through the register form:
// driving the form costs a full page load of /register plus the client-side
// hop to the feed per user (~3s each on CI), which in multi-user tests was
// most of the default 30s budget. The form itself is covered by auth.spec.ts.
//
// - `createUser()` just creates a user and returns its credentials and
//   session — for users that only need to *exist* (e.g. the other side of a
//   direct chat), with no browser context of their own.
// - `signUp(page)` also signs `page`'s browser context in as that user and
//   leaves `page` on the feed, the same end state the register form leaves.
export const test = base.extend<{
  apiUrl: string;
  injectApiUrl: InjectApiUrl;
  createUser: () => Promise<TestUser>;
  signUp: (page: Page) => Promise<TestUser>;
}>({
  apiUrl: async ({}, use) => {
    const backend = await startTestBackend();
    await use(backend.apiUrl);
    await backend.stop();
  },
  injectApiUrl: async ({ apiUrl }, use) => {
    await use(async (context) => {
      await context.addInitScript((url) => {
        (window as unknown as { __E2E_API_URL__?: string }).__E2E_API_URL__ =
          url;
      }, apiUrl);
    });
  },
  context: async ({ context, injectApiUrl }, use) => {
    await injectApiUrl(context);
    await use(context);
  },
  createUser: async ({ apiUrl }, use) => {
    await use(async () => {
      const username = randomUsername();
      const password = TEST_PASSWORD;
      await postJson(`${apiUrl}/users/register`, { username, password });
      const login = await postJson(`${apiUrl}/users/login`, {
        username,
        password,
      });
      const session = (await login.json()) as Session;
      return { username, password, session };
    });
  },
  signUp: async ({ createUser }, use) => {
    await use(async (page) => {
      const user = await createUser();
      // The session has to be in localStorage before the app boots, and
      // localStorage only exists once a document on the app's origin does —
      // so seed it from an init script. It must apply exactly once: init
      // scripts re-run on every navigation in the context, and re-seeding on
      // a later reload would undo a logout or a switch to another user. The
      // per-user marker makes it one-shot (and lets a second `signUp` on the
      // same context take over, since its marker is still unset).
      await page.context().addInitScript(
        ({ key, marker, value }) => {
          try {
            if (window.localStorage.getItem(marker) !== null) return;
            window.localStorage.setItem(key, value);
            window.localStorage.setItem(marker, "1");
          } catch {
            // about:blank and other opaque-origin documents have no
            // localStorage; the next real navigation seeds it instead.
          }
        },
        {
          key: SESSION_STORAGE_KEY,
          marker: `e2e-seeded:${user.username}`,
          value: JSON.stringify(user.session),
        },
      );
      await page.goto("/");
      return user;
    });
  },
});

export { expect } from "@playwright/test";
