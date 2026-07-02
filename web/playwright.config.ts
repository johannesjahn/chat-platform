import { defineConfig, devices } from "@playwright/test";

// The e2e suite drives the real frontend against the real backend, so Playwright
// boots both: the API on 3000 and the Vite dev server on 3001.
const WEB_PORT = 3001;
const API_PORT = 3000;

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
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      // Backend lives one level up; give it a deterministic secret so the run
      // doesn't depend on a local .env (which is gitignored / absent in CI).
      command: "bun run start",
      cwd: "..",
      env: { JWT_SECRET: "e2e-test-secret", PORT: String(API_PORT) },
      url: `http://localhost:${API_PORT}/docs`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "bun run dev",
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
