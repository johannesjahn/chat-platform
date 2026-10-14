import type { BrowserContext, ConsoleMessage, Page } from "@playwright/test";
import { test as base } from "@playwright/test";
import type { components } from "../src/lib/api-types";
import { startTestBackend } from "./backend";
import { randomUsername } from "./helpers";

type Session = components["schemas"]["LoginResponse"];

type InjectApiUrl = (context: BrowserContext) => Promise<void>;

type ErrorPattern = string | RegExp;

// Browser console errors and unhandled rejections that are expected noise
// rather than bugs (issue #618). Anything a page logs that isn't matched
// here fails the test — so give every entry a reason. A test whose subject
// *is* an error should extend the list for itself with `allowConsoleErrors`
// rather than adding to it here.
const CONSOLE_ERROR_ALLOWLIST: readonly ErrorPattern[] = [
  // Taking a context offline (`context.setOffline`) or aborting a route
  // (`route.abort`) makes Chromium log each request it kills — the
  // realtime socket's reconnects and the offline specs' aborted API calls.
  /^Failed to load resource: net::ERR_(INTERNET_DISCONNECTED|FAILED)$/,
];

type ConsoleErrors = {
  allow: (patterns: ErrorPattern[]) => void;
  watch: (context: BrowserContext, apiUrl: string) => void;
  stop: () => void;
};

function matches(text: string, pattern: ErrorPattern): boolean {
  return typeof pattern === "string"
    ? text.includes(pattern)
    : pattern.test(text);
}

// React logs through printf-style formats (`Encountered two children with
// the same key, \`%s\`…`), and `message.text()` leaves those unfilled. Fill
// them from the arguments' previews (a primitive's preview is its value), so
// a failure names the key, the component, and so on.
function formatConsoleMessage(message: ConsoleMessage): string {
  const [format, ...args] = message.args().map((arg) => arg.toString());
  if (format === undefined || !/%[sdifoOc]/.test(format)) {
    return message.text();
  }
  let next = 0;
  return format.replace(/%[sdifoOc]/g, (spec) =>
    spec === "%c" ? (next++, "") : (args[next++] ?? spec),
  );
}

// Chromium logs every non-2xx response as a console error ("Failed to load
// resource: the server responded with a status of 404 …"). From the API
// that's the app's own business — a 401 on a bad login, a 404 on a deleted
// post, a 400 a test fulfils on purpose — and the app surfaces it itself.
// The same message for one of the dev server's own assets is a real bug.
function isApiResponseError(message: ConsoleMessage, apiUrl: string): boolean {
  return (
    message
      .text()
      .startsWith("Failed to load resource: the server responded") &&
    message.location().url.startsWith(apiUrl)
  );
}

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
  consoleErrors: ConsoleErrors;
  allowConsoleErrors: (...patterns: ErrorPattern[]) => void;
  createUser: () => Promise<TestUser>;
  signUp: (page: Page) => Promise<TestUser>;
}>({
  apiUrl: async ({}, use) => {
    const backend = await startTestBackend();
    await use(backend.apiUrl);
    await backend.stop();
  },
  // Collects `console.error`s and uncaught errors/rejections (`pageerror`)
  // from every page of every context that goes through `injectApiUrl`, and
  // fails the test at teardown with their text if any aren't allowlisted.
  consoleErrors: [
    async ({}, use) => {
      // `text` is what patterns match against; `report` is what a failure
      // prints (with the source location or stack).
      const errors: { text: string; report: string }[] = [];
      const allowed: ErrorPattern[] = [...CONSOLE_ERROR_ALLOWLIST];
      let stopped = false;
      await use({
        allow: (patterns) => allowed.push(...patterns),
        stop: () => {
          stopped = true;
        },
        watch: (context, apiUrl) => {
          const onPage = (page: Page) => {
            page.on("console", (message) => {
              if (stopped || message.type() !== "error") return;
              if (isApiResponseError(message, apiUrl)) return;
              const { url, lineNumber } = message.location();
              const text = formatConsoleMessage(message);
              errors.push({
                text,
                report: `console.error at ${url}:${lineNumber}: ${text}`,
              });
            });
            page.on("pageerror", (error) => {
              if (stopped) return;
              errors.push({
                text: error.message,
                // A DOMException (an aborted fetch, a skipped view
                // transition) arrives with an empty `stack`.
                report: `Uncaught ${error.stack || String(error)}`,
              });
            });
          };
          context.pages().forEach(onPage);
          context.on("page", onPage);
        },
      });
      const unexpected = errors.filter(
        ({ text }) => !allowed.some((pattern) => matches(text, pattern)),
      );
      if (unexpected.length > 0) {
        throw new Error(
          `The browser logged ${unexpected.length} unexpected error(s) — fix them, or allowlist expected ones in e2e/fixtures.ts (or per test with allowConsoleErrors):\n\n${unexpected.map(({ report }) => report).join("\n\n")}`,
        );
      }
    },
    { auto: true },
  ],
  // Lets one test accept errors it provokes on purpose, e.g.
  // `allowConsoleErrors(/Something failed/)`, or `/./` to opt out entirely.
  allowConsoleErrors: async ({ consoleErrors }, use) => {
    await use((...patterns) => consoleErrors.allow(patterns));
  },
  injectApiUrl: async ({ apiUrl, consoleErrors }, use) => {
    await use(async (context) => {
      consoleErrors.watch(context, apiUrl);
      await context.addInitScript((url) => {
        (window as unknown as { __E2E_API_URL__?: string }).__E2E_API_URL__ =
          url;
      }, apiUrl);
    });
    // The test is over. Playwright closes the default context only after
    // `apiUrl` has stopped the backend, so whatever its pages log from here
    // on (refused requests, a dropped socket) is teardown, not the test.
    consoleErrors.stop();
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
