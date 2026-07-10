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
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { OfflineBanner } from "@/components/OfflineBanner";
import { PwaUpdatePrompt } from "@/components/PwaUpdatePrompt";
import { VersionFooter } from "@/components/VersionFooter";
import { logout } from "../lib/api";
import { useSession } from "../lib/auth";
import { useTotalUnreadCount } from "../lib/chats";
import { persistOptions, queryClient } from "../lib/query";
import { useRealtimeSocket } from "../lib/realtimeSocket";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
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
    <nav className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card/70 px-4 py-3 backdrop-blur sm:px-5">
      <div className="flex flex-wrap items-center gap-2 sm:gap-4">
        <Link
          to="/"
          className="group relative flex items-center gap-2 font-semibold tracking-tight text-foreground"
        >
          <MessagesSquare className="size-5 text-primary transition-transform duration-300 ease-out group-hover:scale-105 group-hover:rotate-3" />
          <GradientText>Chat Platform</GradientText>
          <span className="pointer-events-none absolute -bottom-1 left-7 h-px w-0 bg-primary transition-all duration-300 ease-out group-hover:w-[calc(100%-1.75rem)]" />
        </Link>
        <Button asChild variant="ghost" size="sm" className="relative">
          <Link to="/chats">
            <MessagesSquare className="size-4" />
            Chats
            {unreadCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex size-4.5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-300">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link to="/users">
            <Users className="size-4" />
            Users
          </Link>
        </Button>
      </div>
      {session ? (
        <div className="flex items-center gap-3">
          <Link
            to="/users/$id"
            params={{ id: String(session.user.id) }}
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            @{session.user.username}
          </Link>
          <Button asChild variant="ghost" size="icon" aria-label="Settings">
            <Link to="/settings">
              <Settings className="size-4" />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              logout(session);
              router.invalidate();
            }}
          >
            <LogOut className="size-4" />
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
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
