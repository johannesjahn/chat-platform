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
  globalSetup: "./e2e/global-setup.ts",
  // `vite dev` compiles route chunks on first request, which is slow on a cold
  // CI runner; the default 5s is too tight for the first assertion after load.
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  // The layout changes at `lg` (1024px) and again at `xl` (1280px), so one
  // viewport only ever exercises one of them (issue #566). The whole suite
  // runs at 1280px — the `xl` desktop layout every spec is written against —
  // and the tests tagged `@layout` (`test(title, { tag: "@layout" }, …)`)
  // run again on a phone and on a wide desktop. Tag a test when what it
  // checks depends on the viewport and it only uses UI every layout has (or
  // the viewport-aware helpers in e2e/helpers.ts); a test that sets its own
  // viewport gains nothing from the extra projects, so leave it untagged.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] }, grep: /@layout/ },
    {
      name: "wide",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
      grep: /@layout/,
    },
  ],
  webServer: {
    command: "bun run dev",
    url: `http://localhost:${WEB_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
