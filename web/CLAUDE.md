# Frontend (`web/`)

TanStack Start (React) in SPA mode on Vite, calling the backend over HTTP.
Paths below are relative to `web/`. Area rules: `src/routes/CLAUDE.md`
(route loaders), `src/lib/CLAUDE.md` (realtime cache, outbox),
`src/components/chat/CLAUDE.md` (the conversation), `e2e/CLAUDE.md`.

## Desktop layout

Mobile-first; from Tailwind's `lg` (1024px) up it switches to a desktop
layout (issue #554). Below `lg` the phone top bar, immersive chat shell and
phone menu stay exactly as they are.

- **Style vs structure.** Styling differences use `lg:`/`xl:` classes.
  Where what _mounts_ differs, read `useIsDesktop()` (`src/lib/media.ts`),
  so the DOM holds one nav and one chat list. The root's `AppNavigation`
  mounts either the phone `Nav` or `DesktopSidebar` (icon rail at `lg`,
  labelled at `xl`).
- **Messaging dock** (`src/components/shell/ChatDock.tsx`,
  `src/lib/chatDock.ts`): docked windows on every non-`/chats` page at
  `lg`+, persisted per user and device. "Message" on a profile or the users
  list opens one (`useStartDirectChat`).
- **Post overlay** (`src/components/feed/PostOverlay.tsx`, issue #561): at
  `lg`+ "Open post" navigates to `/?post=<id>` masked as `/posts/<id>`
  (`unmaskOnReload`), so the URL is shareable, Back closes it and the feed
  keeps its scroll; a reload is the full page. Both render `PostDetail`;
  extend that one component.
- **Overlays and keys**: the command palette and shortcut sheet open through
  `src/lib/shell.ts`; the palette has a `search` mode (`/`; Enter goes to
  `/search`) and a `switcher` mode (`Ctrl/⌘+K`; Enter opens the top match).
  Global keys live in `KeyboardShortcuts`, `Alt+↑/↓` in the chats layout,
  composer keys in `ChatComposer`.
- **Profile hover cards**: wrap an `@mention`, avatar or author name in
  `ProfileHoverCard` (issue #562): mouse-only, opens after 400ms and only
  then fetches `GET /users/{id}`; portalled and stops propagation, so it's
  safe inside a link row or a bubble.
- **Tab badge**: `useTabBadge` prefixes every title with the unread count;
  compare titles through `stripTitleBadge`.
- **Notifications at `xl`+**: a plain click on a `/notifications` row opens
  `NotificationPreviewPane` (issue #564): the post with the comment highlighted
  (via `GET /comments/:id`), an invite's lobby, or a record's leaderboard; modified clicks and Enter still
  navigate, ↑/↓ move the preview.

## Disclosure motion

Anything that expands or collapses in place uses one primitive, so the app
opens and closes with one motion language:

- Panels: `<Collapse open>` (`src/components/ui/collapse.tsx`), paired with
  `<DisclosureChevron open>`. Animates both ways, reverses mid-flight,
  unmounts once closed (or stays `hidden` with `keepMounted`), glides when
  content resizes.
- "Show more" text: `useExpandableText` (`src/lib/motion.ts`).
- Popovers/menus: `useTransitionState` keeps them mounted for
  `animate-pop-close`, the exit half of `animate-pop-open`.

Timing and curves live only in the `--motion-*` tokens ("Disclosure motion"
in `src/styles.css`). Under `prefers-reduced-motion` everything opens and
closes instantly.

## Entry chunk budget

CI's `check:bundle` fails once the gzipped pre-hydration JS, all JS, or all
CSS outgrows `bundle-budget.json` (raise it in the same PR when growth is
deliberate). The pre-hydration figure has ~1.5 kB headroom (issue #754,
#806), so a sizeable eager import trips it.

- `src/client.tsx` hydrates through `RouterClient`, not Start's `StartClient`:
  there are no server functions, and that entry ships seroval and the RPC
  client. A server function or serialization adapter needs `StartClient` back.
- `vite.config.ts` groups the always-loaded framework packages into one
  `framework` chunk. A package only some pages need doesn't belong in it.
- The realtime socket, its cache patchers, browser notifications and offline
  replay live in the lazy `src/components/shell/ShellServices.tsx`; import
  them from there, not from the root or nav.
- Everything in a route file except `component` ships in the entry, so
  `head`/`loader`/`validateSearch` import only light modules:
  `lib/games/names.ts` (not the registry), `lib/chatQueries.ts` (not
  `chats.ts`), `lib/notifications.ts` (icons are in
  `components/notificationIcons.ts`).
- Heavy click-only UI (comments thread, `LazyLightbox`, `InlineComposer`,
  `PostOverlay`, confirm dialog, toast items) is lazy and warmed on idle or
  hover.

## Unit tests

`bun run test` runs `src/**/*.test.ts` (scoped so it skips Playwright's
specs): plain-logic modules, no DOM. Stub browser-only modules (e.g.
`./auth`) with `mock.module`, and start each file with
`/// <reference types="bun" />`, since the web tsconfig only loads
`vite/client` types.
