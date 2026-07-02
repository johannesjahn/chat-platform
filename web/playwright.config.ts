import { defineConfig, devices } from "@playwright/test";

// The e2e suite drives the real frontend against the real backend. The
// frontend is a single shared Vite dev server (it holds no server-side
// state), but each test boots its own backend instance against its own
// SQLite file — see `web/e2e/fixtures.ts` and `web/e2e/backend.ts` — so
// tests can run fully in parallel without sharing database state.
const WEB_PORT = 3001;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run dev",
    url: `http://localhost:${WEB_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
