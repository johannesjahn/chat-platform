# E2E (Playwright, Chromium)

`bun run test:e2e` from `web/`. The `webServer` config
(`web/playwright.config.ts`) boots the real backend (`bun run start` in the
repo root, test `JWT_SECRET`) and a frontend: the Vite dev server by default
(reused if running), or the production build in `web/dist/client` with
`E2E_TARGET=build` (`bun run build` first; served by
`web/scripts/serve-build.ts` with SPA fallback).

- **CI runs the build** (issue #740), so a spec relies only on behaviour and
  URLs the production build has (see `shellChunk` in `offline.spec.ts`).
- **Service workers are blocked** in every spec (`serviceWorkers: "block"`),
  so `page.route` sees every request. A PWA spec opts in with
  `test.use({ serviceWorkers: "allow" })` and skips itself off the build
  (`pwa.spec.ts`).
- **A test fails on any `console.error` or uncaught error/rejection** in
  its pages (issue #618, `consoleErrors` in `fixtures.ts`). Fix what it
  reports; expected noise goes in the commented `CONSOLE_ERROR_ALLOWLIST`,
  and a test that provokes an error allows it with
  `allowConsoleErrors(pattern)`. Extra contexts are watched only through
  `injectApiUrl`, which they already must use.

## Layouts

The suite runs at 1280px, i.e. the desktop layout.

- Beside an open conversation the chat list repeats each chat's newest
  message, so assert conversation text through `page.getByRole("main")`.
- Use the `logOut`/`goToOwnProfile`/`openSearchBox`/`openAccountMenuItem`
  and `longPress` helpers in `helpers.ts` for shell controls and long
  presses.
- Tests tagged `@layout` (`test(title, { tag: "@layout" }, …)`) also run in
  the `phone` (Pixel 7) and `wide` (1440×900) projects (issue #566). Tag a
  test whose assertions depend on the viewport and that uses only UI every
  layout has (the account menu and the bell are desktop-only). Leave a test
  that sets its own viewport untagged. One layout locally:
  `bun run test:e2e --project=phone`.
- Layout specs: `desktop-layout.spec.ts` (1440px and 390px),
  `mobile-breakpoints.spec.ts` (320px, tablet portrait, landscape phone,
  issue #905: the phone top bar and immersive conversation hold),
  `touch-targets.spec.ts` (Pixel 7, issue #906: every visible control on the
  main pages is at least 24×24px, a post's reaction row stays one line, a
  long press on a message opens `MessageActionSheet` with 44px rows).

## Accessibility

`accessibility.spec.ts` scans every main page with axe-core (WCAG 2.x
A/AA) in both themes and, being `@layout`, on all three layouts. A new page
belongs in its list. It freezes transitions before scanning (a theme flip
mid-transition reads as a contrast failure). Avatar initials are
`aria-hidden`, so a control that's only an avatar needs a name of its own.

## CI extras

- `e2e-dev` runs only `accessibility.spec.ts` and
  `attachment-captions.spec.ts` on the dev server, for React's
  development-only `console.error`s and StrictMode double effects.
- `e2e-stress` (PRs) re-runs the specs a PR adds or edits with
  `--repeat-each=5 --retries=0 --timeout=90000` on a busy machine to catch
  timing flakes (issue #619).
