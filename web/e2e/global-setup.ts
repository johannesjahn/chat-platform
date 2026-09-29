import { chromium } from "@playwright/test";

// The e2e suite runs against `vite dev`, which compiles and dep-optimizes the
// app lazily on the first browser request. On a cold CI runner that first load
// can take longer than an `expect` timeout, so whichever tests are scheduled
// first in a shard (the offline specs, currently) used to fail their initial
// attempt and only pass on retry. Loading the app once here, before any test
// starts, pays that cost up front.
export default async function globalSetup() {
  const baseURL = `http://localhost:${process.env.E2E_WEB_PORT ?? 3001}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
    // The unauthenticated app redirects to the login page; visit register too
    // so its route chunks are transformed as well.
    await page.goto(`${baseURL}/register`, { waitUntil: "networkidle" });
  } finally {
    await browser.close();
  }
}
