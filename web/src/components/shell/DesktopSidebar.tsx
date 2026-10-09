import { Link } from "@tanstack/react-router";
import {
  Gamepad2,
  Gauge,
  House,
  MessagesSquare,
  Search,
  Users,
  type LucideIcon,
} from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { NavIcon } from "@/components/NavIcon";
import { GradientText } from "@/components/reactbits/GradientText";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { $api, type Session } from "@/lib/api";
import { useRedirectHere } from "@/lib/redirect";
import { openPalette } from "@/lib/shell";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./AccountMenu";
import { NotificationsPopover } from "./NotificationsPopover";
import { SidebarBadge } from "./SidebarBadge";
import { sidebarItemClassName } from "./sidebarItem";

// The desktop app shell's navigation (issue #554). At `lg`+ it replaces the
// phone/tablet top bar (which is `lg:hidden`) with a full-height sidebar: an
// icon rail at `lg`, widening to labelled rows at `xl`. Feed, Chats,
// Notifications, Users, Games and Admin each get a row with a "you are
// here" state, search opens the command palette, and the account cluster
// sits at the foot behind one avatar button.
//
// It's a second <nav> rather than the top bar restyled: the two differ in
// nearly every element. Only one is ever displayed, so assistive tech and
// role queries only ever see one "Main" navigation.
export function DesktopSidebar({
  session,
  unreadChats,
  unreadNotifications,
  onLogout,
}: {
  session: Session | null;
  unreadChats: number;
  unreadNotifications: number;
  onLogout: (() => void) | undefined;
}) {
  const redirect = useRedirectHere();
  const { data: version } = $api.useQuery("get", "/version");

  return (
    <nav
      data-app-sidebar
      aria-label="Main"
      className="sticky top-0 z-30 hidden h-[var(--app-height,100dvh)] w-[4.75rem] shrink-0 flex-col gap-1 border-r border-border bg-card/70 px-3 pb-3 pt-4 backdrop-blur lg:flex xl:w-64"
    >
      <Link
        to="/"
        className="group mb-3 flex h-11 items-center justify-center gap-2 rounded-xl font-semibold tracking-tight text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring xl:justify-start xl:px-3"
      >
        <BrandLogo />
        {/* The wordmark only fits once the rail widens; it stays the link's
            accessible name on the rail. */}
        <span className="sr-only xl:not-sr-only">
          <GradientText>Chat Platform</GradientText>
        </span>
      </Link>

      {session && (
        <button
          type="button"
          onClick={() => openPalette("search")}
          aria-keyshortcuts="/"
          title="Search (/)"
          className={cn(
            sidebarItemClassName,
            "group/nav-icon mb-2 border border-border bg-background/40",
          )}
        >
          <NavIcon icon={Search} className="size-5" />
          <span className="sr-only xl:not-sr-only">Search</span>
          <kbd className="ml-auto hidden rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground xl:inline">
            /
          </kbd>
        </button>
      )}

      <SidebarLink to="/" icon={House} label="Feed" exact />
      <SidebarLink
        to="/chats"
        icon={MessagesSquare}
        label="Chats"
        badge={unreadChats}
      />
      {session && <NotificationsPopover unread={unreadNotifications} />}
      <SidebarLink to="/users" icon={Users} label="Users" />
      <SidebarLink to="/games" icon={Gamepad2} label="Games" />
      {/* The dashboard route enforces this server-side too (the endpoint
          403s a non-admin) — hiding the link just keeps a dead end out of
          everyone else's nav. */}
      {session?.user.role === "admin" && (
        <SidebarLink to="/admin" icon={Gauge} label="Admin" />
      )}

      <div className="flex-1" />

      <ThemeToggle variant="sidebar" className="mb-1" />

      {session && onLogout ? (
        <AccountMenu session={session} onLogout={onLogout} />
      ) : (
        <div className="flex flex-col gap-2">
          <Button asChild variant="ghost" size="sm" className="w-full">
            <Link to="/login" search={{ redirect }}>
              Log in
            </Link>
          </Button>
          <Button asChild size="sm" className="w-full">
            <Link to="/register" search={{ redirect }}>
              Register
            </Link>
          </Button>
        </div>
      )}
      {/* The build tag the phone/tablet layout pins to the screen's corner
          (VersionFooter) lives here at `lg`+, where that corner is the
          composer's send button in a full-width conversation. */}
      {version && (
        <span
          data-version-tag
          className="mt-1 hidden text-center text-[11px] text-muted-foreground/60 select-none xl:block"
        >
          v{version.version}
        </span>
      )}
    </nav>
  );
}

function SidebarLink({
  to,
  icon,
  label,
  badge = 0,
  exact = false,
}: {
  to: "/" | "/chats" | "/users" | "/games" | "/admin";
  icon: LucideIcon;
  label: string;
  badge?: number;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      title={label}
      aria-label={badge > 0 ? `${label} (${badge} unread)` : undefined}
      className={cn(sidebarItemClassName, "group/nav-icon")}
    >
      <span className="relative flex">
        <NavIcon icon={icon} className="size-5" />
        <SidebarBadge count={badge} />
      </span>
      <span className="sr-only xl:not-sr-only">{label}</span>
    </Link>
  );
}
