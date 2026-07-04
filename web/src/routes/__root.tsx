import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { LogOut, MessagesSquare, Users } from "lucide-react";
import type { ReactNode } from "react";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { clearSession, useSession } from "../lib/auth";
import { useTotalUnreadCount } from "../lib/chats";
import { queryClient } from "../lib/query";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Chat Platform" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <Nav />
        <Outlet />
      </QueryClientProvider>
    </RootDocument>
  );
}

function Nav() {
  const session = useSession();
  const router = useRouter();
  const unreadCount = useTotalUnreadCount(!!session);

  return (
    <nav className="sticky top-0 z-20 flex items-center gap-4 border-b border-border bg-card/70 px-5 py-3 backdrop-blur">
      <Link
        to="/"
        className="group relative flex items-center gap-2 font-semibold tracking-tight text-foreground"
      >
        <MessagesSquare className="size-5 text-primary transition-transform duration-300 group-hover:scale-110 group-hover:rotate-6" />
        <GradientText>Chat Platform</GradientText>
        <span className="pointer-events-none absolute -bottom-1 left-7 h-px w-0 bg-primary transition-all duration-300 group-hover:w-[calc(100%-1.75rem)]" />
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
      <span className="flex-1" />
      {session ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            @{session.user.username}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearSession();
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
