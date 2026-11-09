import { chromium } from "@playwright/test";
import { E2E_TARGET } from "./target";

// Under `vite dev` (the default target), the app is compiled and
// dep-optimized lazily on the first browser request. On a cold runner that
// first load can take longer than an `expect` timeout, so whichever tests
// were scheduled first in a shard (the offline specs, at the time) used to
// fail their initial attempt and only pass on retry. Loading the app once
// here, before any test starts, pays that cost up front. The production
// build (`E2E_TARGET=build`) is prebuilt, so there's nothing to warm.
export default async function globalSetup() {
  if (E2E_TARGET === "build") return;
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
