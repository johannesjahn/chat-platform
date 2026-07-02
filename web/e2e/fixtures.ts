import type { BrowserContext } from "@playwright/test";
import { test as base } from "@playwright/test";
import { startTestBackend } from "./backend";

type InjectApiUrl = (context: BrowserContext) => Promise<void>;

// Extends Playwright's `test` with an `apiUrl` fixture: a dedicated backend
// process + SQLite file, started fresh for every test and torn down after.
// The default `context` fixture is overridden to point the frontend at it
// (see `injectApiUrl` below) — tests that create their own extra contexts
// (e.g. to simulate two separate users) must call `injectApiUrl` themselves
// before creating pages from those contexts.
export const test = base.extend<{
  apiUrl: string;
  injectApiUrl: InjectApiUrl;
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
});

export { expect } from "@playwright/test";
