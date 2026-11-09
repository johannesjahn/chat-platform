// Which frontend the suite runs against — see playwright.config.ts. Read
// from the environment, which Playwright's workers inherit.
export const E2E_TARGET: "dev" | "build" =
  process.env.E2E_TARGET === "build" ? "build" : "dev";
