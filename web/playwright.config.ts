import { defineConfig, devices } from "@playwright/test";
import { E2E_TARGET } from "./e2e/target";

// The e2e suite drives the real frontend against the real backend. The
// frontend is one shared web server (it holds no server-side state), but
// each test boots its own backend instance against its own database — see
// `web/e2e/fixtures.ts` and `web/e2e/backend.ts` — so tests can run fully in
// parallel without sharing database state.
//
// Which frontend that is depends on `E2E_TARGET` (issue #740):
// - unset (the default, for the local loop): the Vite dev server, reused if
//   one is already running, so a change needs no rebuild;
// - `build`: the production build in dist/client (`bun run build` first),
//   served as the static deploy serves it — see scripts/serve-build.ts. CI
//   runs every e2e job but `e2e-dev` this way, so it tests the chunking,
//   modulepreload and production React that users actually get, without
//   the dev server's compile-on-first-request races.
const WEB_PORT = 3001;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  globalSetup: "./e2e/global-setup.ts",
  // The default 5s is too tight for the first assertion after a load on a
  // busy CI runner, where each test also boots its own backend — and under
  // `vite dev` the first request for a route also compiles its chunks.
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // The production build registers a service worker. Once one controls a
    // page, `page.route` no longer sees the requests it answers from its
    // precache — which the specs that route or abort requests rely on — and
    // the offline specs could pass because the SW served what they meant to
    // fail. So it's blocked everywhere; a spec about the PWA itself opts in
    // with `test.use({ serviceWorkers: "allow" })` (see pwa.spec.ts).
    serviceWorkers: "block",
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
  webServer:
    E2E_TARGET === "build"
      ? {
          command: "bun scripts/serve-build.ts",
          url: `http://localhost:${WEB_PORT}`,
          env: { PORT: String(WEB_PORT) },
          // Never a dev server that happens to be up on the same port.
          reuseExistingServer: false,
          timeout: 10_000,
        }
      : {
          command: "bun run dev",
          url: `http://localhost:${WEB_PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
});
