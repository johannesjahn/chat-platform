import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import {
  Bell,
  Gamepad2,
  Gauge,
  LogOut,
  Menu,
  MessagesSquare,
  Settings,
  User,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useState,
} from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { NavIcon } from "@/components/NavIcon";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { HeaderSearch } from "@/components/HeaderSearch";
import { OfflineBanner } from "@/components/OfflineBanner";
import { SessionPlaceholder } from "@/components/SessionPlaceholder";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyboardShortcuts } from "@/components/shell/KeyboardShortcuts";
import { VersionFooter } from "@/components/VersionFooter";
import { logout } from "../lib/api";
import {
  SESSION_BOOT_SCRIPT,
  useSession,
  useSessionPending,
} from "../lib/auth";
import { useBrowserNotifications } from "../lib/browserNotifications";
import { useDockUser } from "../lib/chatDock";
import { lazyNamed, type PreloadableComponent, whenIdle } from "../lib/lazy";
import { DESKTOP_MEDIA_QUERY, useIsDesktop } from "../lib/media";
import { useChatsList, useTotalUnreadCount } from "../lib/chats";
import { useUnreadNotificationCount } from "../lib/notifications";
import { OfflineQueueSync } from "../lib/offlineQueue";
import { persistOptions, queryClient } from "../lib/query";
import { useRealtimeSocket } from "../lib/realtimeSocket";
import { useRedirectHere } from "../lib/redirect";
import { type ShellOverlay, useOverlayOpen } from "../lib/shell";
import { useTabBadge } from "../lib/tabBadge";
import { THEME_BOOT_SCRIPT } from "../lib/theme";
import { userLabel } from "../lib/users";
import { useAppHeight } from "../lib/viewport";
import appCss from "../styles.css?url";

// Shell pieces kept out of the entry chunk (issue #604): every cold load
// downloads, parses and runs that chunk before hydrating, on every route,
// while these render nothing until they're used, or only on one layout.
// The dock alone drags in the whole conversation view (bubbles, composer,
// lightbox, group settings).
const DesktopSidebar = lazyNamed(
  () => import("@/components/shell/DesktopSidebar"),
  "DesktopSidebar",
);
const ChatDock = lazyNamed(
  () => import("@/components/shell/ChatDock"),
  "ChatDock",
);
const CommandPalette = lazyNamed(
  () => import("@/components/shell/CommandPalette"),
  "CommandPalette",
);
const ShortcutsDialog = lazyNamed(
  () => import("@/components/shell/ShortcutsDialog"),
  "ShortcutsDialog",
);
const PwaUpdatePrompt = lazyNamed(
  () => import("@/components/PwaUpdatePrompt"),
  "PwaUpdatePrompt",
);

// On a desktop-width window, start fetching the sidebar as soon as this
// module runs — alongside hydration rather than after it.
if (
  typeof window !== "undefined" &&
  window.matchMedia(DESKTOP_MEDIA_QUERY).matches
) {
  DesktopSidebar.preload().catch(() => {});
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        // `viewport-fit=cover` — `apple-mobile-web-app-capable` +
        // `black-translucent` below ask iOS to draw a Home Screen install
        // under the status bar and home indicator, but since iOS 11 the page
        // only actually extends into those areas with this set. It's what
        // makes `env(safe-area-inset-*)` report anything, so the nav and the
        // composer can inset themselves (they do) instead of the composer
        // sitting under the home indicator with the newest messages behind it.
        //
        // `interactive-widget=resizes-content` — tells Android Chrome to
        // shrink the *layout* viewport when the on-screen keyboard opens
        // rather than only the visual one (its `resizes-visual` default), so
        // `dvh` is simply correct there and matches what `useAppHeight`
        // measures. iOS ignores the key; `useAppHeight` is what covers it.
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { title: "Chat Platform" },
      // Default summary for search results and link previews (issue #706).
      // A page with a better one can override it the way it overrides the
      // title — TanStack dedupes `meta` by name, the deepest match winning.
      {
        name: "description",
        content:
          "Chat Platform — real-time chats, posts and multiplayer games with friends.",
      },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      {
        name: "apple-mobile-web-app-status-bar-style",
        content: "black-translucent",
      },
      { name: "apple-mobile-web-app-title", content: "Chat Platform" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/favicon-192x192.png" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={persistOptions}
      >
        <ConfirmProvider>
          <ToastProvider>
            <OfflineQueueSync />
            <SkipLink />
            {/* The frame is a column below `lg` — the top bar over the page,
              as it always was — and a row from `lg` up, where the desktop
              sidebar takes the left edge and the page fills the rest
              (issue #554). `data-app-frame`/`data-app-column` are what the
              immersive shell clamps to the viewport (see styles.css). */}
            <div data-app-frame className="flex grow flex-col lg:flex-row">
              <AppNavigation />
              <div data-app-column className="flex min-w-0 grow flex-col">
                <OfflineBanner />
                <Outlet />
              </div>
            </div>
            <VersionFooter />
            <ChatDockSlot />
            <Suspense fallback={null}>
              <PwaUpdatePrompt />
            </Suspense>
            <LazyOverlay overlay="palette" component={CommandPalette} />
            <LazyOverlay overlay="shortcuts" component={ShortcutsDialog} />
            <KeyboardShortcuts />
          </ToastProvider>
        </ConfirmProvider>
      </PersistQueryClientProvider>
    </RootDocument>
  );
}

// The first tab stop on every page (issue #497): hidden until focused, it
// jumps past the nav to the page's own <main> — every route renders one —
// so a keyboard user doesn't tab through the whole header on each page.
// It moves focus itself rather than following a `#fragment`: routes don't
// share an id for their <main>, and a bare hash change would also land in
// the router's history.
function SkipLink() {
  return (
    <a
      href="#main"
      onClick={(e) => {
        // Never follow the href, even before the route's <main> has
        // rendered: that would only put a dead `#main` into history.
        e.preventDefault();
        const main = document.querySelector("main");
        if (!main) return;
        if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
        main.focus();
      }}
      className="sr-only rounded-md bg-primary text-sm font-medium text-primary-foreground shadow-md outline-none focus:not-sr-only focus:fixed focus:px-3 focus:py-2 focus:left-4 focus:top-[calc(0.5rem+env(safe-area-inset-top))] focus:z-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      Skip to content
    </a>
  );
}

// The desktop messaging dock's gate (issue #554): signed in, at `lg`+, and
// off `/chats/*`. It lives here rather than in ChatDock.tsx so the dock —
// and the conversation view it renders — is only fetched once it's shown
// (issue #604). The dock is `fixed`, so it arriving a beat later moves
// nothing on the page.
function ChatDockSlot() {
  const session = useSession();
  const isDesktop = useIsDesktop();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useDockUser(session?.user.id ?? null);
  const onChats = pathname === "/chats" || pathname.startsWith("/chats/");
  if (!session || !isDesktop || onChats) return null;
  return (
    <Suspense fallback={null}>
      <ChatDock session={session} />
    </Suspense>
  );
}

// Mounts a lazily loaded shell overlay (the palette, the shortcut sheet)
// the first time the overlay store opens it, and keeps it mounted after so
// it can play its close animation (issue #604). The global key handler
// stays eager and only flips the store, so the first keypress still opens
// it — and its chunk is warmed on idle, so that's rarely a network wait.
function LazyOverlay({
  overlay,
  component: Overlay,
}: {
  overlay: ShellOverlay;
  component: PreloadableComponent<ComponentType>;
}) {
  const open = useOverlayOpen(overlay);
  const [wanted, setWanted] = useState(open);
  if (open && !wanted) setWanted(true);
  useEffect(
    () => whenIdle(() => void Overlay.preload().catch(() => {})),
    [Overlay],
  );
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <Overlay />
    </Suspense>
  );
}

// Owns what both navigations share — the realtime socket, the unread counts
// (and with them the tab badge), logging out — and renders whichever of the
// phone/tablet top bar and the desktop sidebar fits the window. Only one is
// mounted, so there's never a second, hidden copy of every link and name in
// the document; the bar's `lg:hidden` and the sidebar's `hidden lg:flex`
// still hold the line for the first frame, before the media query is read.
//
// The phone bar is the prerendered, mobile-first default, so it stays in
// the entry chunk; the sidebar is a lazy chunk (issue #604). Until it's in,
// `SidebarSpace` holds its width — in the prerendered shell too, where it's
// rendered beside the bar — so the page never shifts sideways when it lands.
function AppNavigation() {
  const session = useSession();
  const router = useRouter();
  const isDesktop = useIsDesktop();
  useRealtimeSocket(!!session);
  const unreadCount = useTotalUnreadCount(!!session);
  const unreadNotifications = useUnreadNotificationCount(!!session);
  useTabBadge(unreadCount + unreadNotifications);
  const { data: chatsData } = useChatsList(!!session);
  useBrowserNotifications({
    currentUserId: session?.user.id,
    chats: chatsData?.pages.flatMap((page) => page.chats) ?? [],
    unreadChats: unreadCount,
    unreadNotifications,
  });

  const onLogout = session
    ? () => {
        logout(session);
        // Leave whatever page was open (e.g. /settings) rather than
        // re-rendering it half signed out (issue #499).
        void router.navigate({ to: "/" });
        router.invalidate();
      }
    : undefined;

  return isDesktop ? (
    <Suspense fallback={<SidebarSpace />}>
      <DesktopSidebar
        session={session}
        unreadChats={unreadCount}
        unreadNotifications={unreadNotifications}
        onLogout={onLogout}
      />
    </Suspense>
  ) : (
    <>
      <Nav
        session={session}
        unreadCount={unreadCount}
        unreadNotifications={unreadNotifications}
        onLogout={onLogout}
      />
      <SidebarSpace />
    </>
  );
}

// An empty stand-in exactly as wide as the desktop sidebar (`w-[4.75rem]
// xl:w-64` on its <nav>), shown only from `lg` up.
function SidebarSpace() {
  return (
    <div aria-hidden className="hidden w-[4.75rem] shrink-0 lg:block xl:w-64" />
  );
}

function Nav({
  session,
  unreadCount,
  unreadNotifications,
  onLogout,
}: {
  session: ReturnType<typeof useSession>;
  unreadCount: number;
  unreadNotifications: number;
  onLogout: (() => void) | undefined;
}) {
  const redirect = useRedirectHere();
  const sessionPending = useSessionPending();
  const menuId = useId();
  // The phone menu remembers the location it was opened on rather than a
  // bare boolean, so any navigation — a menu link, a search submit, the
  // brand — closes it and it never stays open over the page it led to.
  const href = useRouterState({ select: (s) => s.location.href });
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null);
  const menuOpen = menuOpenAt === href;
  const setMenuOpen = (open: boolean) => setMenuOpenAt(open ? href : null);
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpenAt(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    // `pt-[calc(...)]` rather than `py-3`: `viewport-fit=cover` lets the page
    // run under the status bar and the notch, so the nav owns that inset —
    // its background then fills the area instead of the bar overlapping the
    // links. Resolves to plain `0.75rem` everywhere `env()` is 0.
    //
    // Below `sm` it's a single row — brand, Chats, the bell, and a menu
    // button — with search and everything else in the menu panel (issue
    // #494): the full set wrapped onto three rows there and, pinned, took
    // about a third of a phone screen. Links that only live in the menu on a
    // phone are `hidden sm:inline-flex` in the bar rather than rendered twice
    // visibly, so each has one accessible copy at any width.
    //
    // `data-app-nav` is what the immersive shell hides on phone widths while
    // a conversation is open (see the rules in styles.css, switched on by
    // `useImmersiveShell`) — the chat has its own header and back button.
    //
    // `lg:hidden`: from `lg` up the desktop sidebar is the navigation
    // instead (issue #554), so this bar is phone/tablet only.
    <nav
      data-app-nav
      aria-label="Main"
      className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card/70 px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur sm:px-5 lg:hidden"
    >
      <div className="flex min-w-0 items-center gap-2 sm:flex-wrap sm:gap-4">
        <Link
          to="/"
          className="group relative flex items-center gap-2 font-semibold tracking-tight text-foreground"
        >
          <BrandLogo />
          {/* The entrance lives on this wrapper, not on GradientText itself:
              GradientText already owns its element's `animation` (the gradient
              drift), and a second shorthand on the same element would simply
              replace it. On the narrowest phones the wordmark steps aside
              (still the link's accessible name) so the row never wraps. */}
          <span className="inline-block motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-2 motion-safe:duration-700 max-[22.5rem]:sr-only">
            <GradientText>Chat Platform</GradientText>
          </span>
          <span className="pointer-events-none absolute -bottom-1 left-7 h-px w-0 bg-primary transition-all duration-300 ease-out group-hover:w-[calc(100%-1.75rem)]" />
        </Link>
        <Button asChild variant="ghost" size="sm" className="relative">
          <Link to="/chats" className="group/nav-icon">
            <NavIcon icon={MessagesSquare} />
            {/* Icon-only on a phone; the label stays the accessible name. */}
            <span className="max-sm:sr-only">Chats</span>
            {unreadCount > 0 && (
              <span
                // Re-keyed on the count so the pop replays every time a new
                // message arrives, not only the first time the badge appears.
                key={unreadCount}
                className="absolute -right-1.5 -top-1.5 flex size-4.5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground motion-safe:animate-badge-pop"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Link>
        </Button>
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="hidden sm:inline-flex"
        >
          <Link to="/users" className="group/nav-icon">
            <NavIcon icon={Users} />
            Users
          </Link>
        </Button>
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="hidden sm:inline-flex"
        >
          <Link to="/games" className="group/nav-icon">
            <NavIcon icon={Gamepad2} />
            Games
          </Link>
        </Button>
        {/* The dashboard route enforces this server-side too (the endpoint
            403s a non-admin) — hiding the link just keeps a dead end out of
            everyone else's nav. */}
        {session?.user.role === "admin" && (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="hidden sm:inline-flex"
          >
            <Link to="/admin" className="group/nav-icon">
              <NavIcon icon={Gauge} />
              Admin
            </Link>
          </Button>
        )}
      </div>
      {session && <HeaderSearch className="hidden sm:block" />}
      <div className="flex items-center gap-2 sm:gap-3">
        {sessionPending ? (
          // The prerendered shell (issue #603): a signed-in reader gets
          // placeholders the size of their actions, never "Log in".
          <SessionPlaceholder
            signedIn={<NavActionsSkeleton />}
            signedOut={<SignedOutNavActions redirect={redirect} />}
          />
        ) : session ? (
          <>
            <Link
              to="/users/$id"
              params={{ id: String(session.user.id) }}
              // `link-sweep` draws the underline in from the left rather than
              // switching it on whole, and retracts it the same way — see
              // styles.css.
              className="link-sweep hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              {userLabel(session.user)}
            </Link>
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="relative"
              aria-label={
                unreadNotifications > 0
                  ? `Notifications (${unreadNotifications} unread)`
                  : "Notifications"
              }
            >
              <Link to="/notifications" className="group/nav-icon">
                <NavIcon icon={Bell} />
                {unreadNotifications > 0 && (
                  <span
                    // Re-keyed like the Chats badge so the pop replays on
                    // every new notification.
                    key={unreadNotifications}
                    className="absolute -right-1 -top-1 flex size-4.5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground motion-safe:animate-badge-pop"
                  >
                    {unreadNotifications > 99 ? "99+" : unreadNotifications}
                  </span>
                )}
              </Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              size="icon"
              aria-label="Settings"
              className="hidden sm:inline-flex"
            >
              <Link to="/settings" className="group/nav-icon">
                <NavIcon icon={Settings} />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="group/nav-icon hidden sm:inline-flex"
              onClick={onLogout}
            >
              <NavIcon icon={LogOut} />
              Log out
            </Button>
          </>
        ) : (
          <SignedOutNavActions redirect={redirect} />
        )}
        {/* Below `sm` the bar is one row with no room to spare (issue
            #494), so there the toggle lives in the menu panel instead. */}
        <ThemeToggle className="hidden sm:inline-flex" />
        <Button
          variant="ghost"
          size="icon"
          className="group/nav-icon sm:hidden"
          aria-label="Menu"
          aria-expanded={menuOpen}
          // The panel unmounts once closed, so it's only pointed at while
          // it's there.
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <NavIcon icon={menuOpen ? X : Menu} />
        </Button>
      </div>
      <Collapse open={menuOpen} id={menuId} className="basis-full sm:hidden">
        {/* Activating anything in the panel closes it, even when the URL
            doesn't change — the current page's own link, or logging out on
            `/` — which the href check above can't see (issue #545). Clicks
            and submits bubble, so one handler covers every item. */}
        <div
          className="flex flex-col gap-1 pt-1"
          onClick={(e) => {
            if ((e.target as Element).closest("a, button")) setMenuOpen(false);
          }}
          onSubmit={() => setMenuOpen(false)}
        >
          {session && <HeaderSearch className="mb-2" />}
          <MenuLink to="/users" icon={Users} label="Users" />
          <MenuLink to="/games" icon={Gamepad2} label="Games" />
          {session?.user.role === "admin" && (
            <MenuLink to="/admin" icon={Gauge} label="Admin" />
          )}
          <ThemeToggle variant="menu" />
          {session ? (
            <>
              <Button
                asChild
                variant="ghost"
                className="group/nav-icon justify-start"
              >
                <Link to="/users/$id" params={{ id: String(session.user.id) }}>
                  <NavIcon icon={User} />
                  <span className="min-w-0 truncate">
                    {userLabel(session.user)}
                  </span>
                </Link>
              </Button>
              <MenuLink to="/settings" icon={Settings} label="Settings" />
              <Button
                variant="ghost"
                className="group/nav-icon justify-start"
                onClick={onLogout}
              >
                <NavIcon icon={LogOut} />
                Log out
              </Button>
            </>
          ) : (
            <Button asChild className="mt-1">
              <Link to="/register" search={{ redirect }}>
                Register
              </Link>
            </Button>
          )}
        </div>
      </Collapse>
    </nav>
  );
}

function SignedOutNavActions({ redirect }: { redirect: string | undefined }) {
  return (
    <>
      <Button asChild variant="ghost" size="sm">
        <Link to="/login" search={{ redirect }}>
          Log in
        </Link>
      </Button>
      <Button asChild size="sm" className="hidden sm:inline-flex">
        <Link to="/register" search={{ redirect }}>
          Register
        </Link>
      </Button>
    </>
  );
}

// Stands in for the signed-in actions — name, bell, settings, log out —
// at their sizes and breakpoints, so nothing shifts once they render.
function NavActionsSkeleton() {
  return (
    <>
      <Skeleton className="hidden h-4 w-20 sm:block" />
      <Skeleton className="size-9" />
      <Skeleton className="hidden size-9 sm:block" />
      <Skeleton className="hidden h-8 w-24 sm:block" />
    </>
  );
}

// A full-width row in the phone menu panel.
function MenuLink({
  to,
  icon,
  label,
}: {
  to: "/users" | "/games" | "/admin" | "/settings";
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Button asChild variant="ghost" className="group/nav-icon justify-start">
      <Link to={to}>
        <NavIcon icon={icon} />
        {label}
      </Link>
    </Button>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  useAppHeight();
  return (
    // The theme class (`dark`/`light`), `color-scheme` and the
    // `theme-color` meta are owned by lib/theme.ts, not React: the inline
    // boot script sets them before the first paint, from the stored choice
    // or `prefers-color-scheme` (issue #315). React never renders them, so
    // nothing resets or duplicates them; the hydration warning is
    // suppressed for the <html> attribute mismatch. `data-session` is the
    // same kind of attribute, owned by lib/auth.ts (issue #603).
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {/* Marks <html> signed in or out before the first paint, so the
            prerendered shell shows the right placeholders (issue #603). */}
        <script dangerouslySetInnerHTML={{ __html: SESSION_BOOT_SCRIPT }} />
      </head>
      {/* `--app-height` is the visual viewport — what's actually on screen
          once the keyboard and the dynamic toolbar have had their say — with
          `100dvh` left as the fallback for browsers without the API. See
          lib/viewport.ts for why `100dvh` alone isn't it on a phone.

          The horizontal safe-area insets live here rather than on each piece
          of chrome because `viewport-fit=cover` only exposes them in
          landscape on a notched device, where one padding on the scroll root
          is enough; the vertical ones are on the nav and the composer
          instead, so their backgrounds still run edge to edge in portrait. */}
      <body className="flex min-h-[var(--app-height,100dvh)] flex-col pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
