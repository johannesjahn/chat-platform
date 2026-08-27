import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { LogOut, MessagesSquare, Settings, Users } from "lucide-react";
import type { ReactNode } from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { NavIcon } from "@/components/NavIcon";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { HeaderSearch } from "@/components/HeaderSearch";
import { OfflineBanner } from "@/components/OfflineBanner";
import { PwaUpdatePrompt } from "@/components/PwaUpdatePrompt";
import { VersionFooter } from "@/components/VersionFooter";
import { logout } from "../lib/api";
import { useSession } from "../lib/auth";
import { useTotalUnreadCount } from "../lib/chats";
import { OfflineQueueSync } from "../lib/offlineQueue";
import { persistOptions, queryClient } from "../lib/query";
import { useRealtimeSocket } from "../lib/realtimeSocket";
import { userLabel } from "../lib/users";
import { useAppHeight } from "../lib/viewport";
import appCss from "../styles.css?url";

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
      { name: "theme-color", content: "#0b0d13" },
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
        <OfflineQueueSync />
        <Nav />
        <OfflineBanner />
        <Outlet />
        <VersionFooter />
        <PwaUpdatePrompt />
      </PersistQueryClientProvider>
    </RootDocument>
  );
}

function Nav() {
  const session = useSession();
  const router = useRouter();
  useRealtimeSocket(!!session);
  const unreadCount = useTotalUnreadCount(!!session);

  return (
    // `pt-[calc(...)]` rather than `py-3`: `viewport-fit=cover` lets the page
    // run under the status bar and the notch, so the nav owns that inset —
    // its background then fills the area instead of the bar overlapping the
    // links. Resolves to plain `0.75rem` everywhere `env()` is 0.
    // `data-app-nav` is what the immersive shell hides on phone widths while
    // a conversation is open (see the rules in styles.css, switched on by
    // `useImmersiveShell`) — the chat has its own header and back button, and
    // these three wrapped rows are the space the thread needs once the
    // on-screen keyboard is up.
    <nav
      data-app-nav
      className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card/70 px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur sm:px-5"
    >
      <div className="flex flex-wrap items-center gap-2 sm:gap-4">
        <Link
          to="/"
          className="group relative flex items-center gap-2 font-semibold tracking-tight text-foreground"
        >
          <BrandLogo />
          {/* The entrance lives on this wrapper, not on GradientText itself:
              GradientText already owns its element's `animation` (the gradient
              drift), and a second shorthand on the same element would simply
              replace it. */}
          <span className="inline-block motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-2 motion-safe:duration-700">
            <GradientText>Chat Platform</GradientText>
          </span>
          <span className="pointer-events-none absolute -bottom-1 left-7 h-px w-0 bg-primary transition-all duration-300 ease-out group-hover:w-[calc(100%-1.75rem)]" />
        </Link>
        <Button asChild variant="ghost" size="sm" className="relative">
          <Link to="/chats" className="group/nav-icon">
            <NavIcon icon={MessagesSquare} />
            Chats
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
        <Button asChild variant="ghost" size="sm">
          <Link to="/users" className="group/nav-icon">
            <NavIcon icon={Users} />
            Users
          </Link>
        </Button>
      </div>
      {session && <HeaderSearch />}
      {session ? (
        <div className="flex items-center gap-3">
          <Link
            to="/users/$id"
            params={{ id: String(session.user.id) }}
            // `link-sweep` draws the underline in from the left rather than
            // switching it on whole, and retracts it the same way — see
            // styles.css.
            className="link-sweep text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {userLabel(session.user)}
          </Link>
          <Button asChild variant="ghost" size="icon" aria-label="Settings">
            <Link to="/settings" className="group/nav-icon">
              <NavIcon icon={Settings} />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="group/nav-icon"
            onClick={() => {
              logout(session);
              router.invalidate();
            }}
          >
            <NavIcon icon={LogOut} />
            Log out
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/login">Log in</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/register">Register</Link>
          </Button>
        </div>
      )}
    </nav>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  useAppHeight();
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
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
