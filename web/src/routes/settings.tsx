import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Bell,
  KeyRound,
  Palette,
  Settings,
  Shield,
  Smile,
  Trash2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { filterRailRowClassName } from "@/components/filterRailStyles";
import { LoginPrompt } from "@/components/LoginPrompt";
import { GradientText } from "@/components/reactbits/GradientText";
import { useSession } from "@/lib/auth";
import { useIsDesktop } from "@/lib/media";
import { staticTitle } from "@/lib/title";
import { AppearanceCard } from "@/components/settings/AppearanceCard";
import { BrowserNotificationsCard } from "@/components/settings/BrowserNotificationsCard";
import { EditStatusCard } from "@/components/settings/EditStatusCard";
import { BlockedUsersCard } from "@/components/settings/BlockedUsersCard";
import { EditProfileCard } from "@/components/settings/EditProfileCard";
import { ChangePasswordCard } from "@/components/settings/ChangePasswordCard";
import { DeleteAccountCard } from "@/components/settings/DeleteAccountCard";

// The section names alone, for `validateSearch`: route options other than
// the component stay in the entry chunk, so reading `SECTIONS` there would
// ship every section's icon to every cold load (issue #754).
const SECTION_VALUES = [
  "profile",
  "status",
  "appearance",
  "privacy",
  "notifications",
  "password",
  "account",
] as const;

type Section = (typeof SECTION_VALUES)[number];

const SECTIONS: ReadonlyArray<{
  value: Section;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "profile", label: "Profile", icon: UserRound },
  { value: "status", label: "Status", icon: Smile },
  { value: "appearance", label: "Appearance", icon: Palette },
  { value: "privacy", label: "Blocked & muted", icon: Shield },
  { value: "notifications", label: "Notifications", icon: Bell },
  { value: "password", label: "Password", icon: KeyRound },
  { value: "account", label: "Delete account", icon: Trash2 },
];

type SettingsSearch = { section?: Section };

export const Route = createFileRoute("/settings")({
  head: () => staticTitle("Settings"),
  // `?section=` picks the desktop view's section (issue #554), so each one
  // is addressable — `/settings?section=password` — and the back button
  // walks back through the ones visited.
  validateSearch: (search: Record<string, unknown>): SettingsSearch =>
    SECTION_VALUES.some((value) => value === search.section)
      ? { section: search.section as Section }
      : {},
  component: SettingsPage,
});

function SectionCard({ section }: { section: Section }) {
  switch (section) {
    case "profile":
      return <EditProfileCard />;
    case "status":
      return <EditStatusCard />;
    case "appearance":
      return <AppearanceCard />;
    case "privacy":
      return <BlockedUsersCard />;
    case "notifications":
      return <BrowserNotificationsCard />;
    case "password":
      return <ChangePasswordCard />;
    case "account":
      return <DeleteAccountCard />;
  }
}

function SettingsPage() {
  const session = useSession();
  const { section = "profile" } = Route.useSearch();
  // Below `lg` it's every card in one column, as it always was; at `lg`+ a
  // sidebar picks one section at a time — the desktop settings pattern
  // rather than one long scroll (issue #554).
  const isDesktop = useIsDesktop();

  return (
    <main className="mx-auto flex w-full max-w-xl gap-8 px-4 py-10 lg:max-w-4xl">
      {session && (
        <nav
          aria-label="Settings sections"
          className="sticky top-10 hidden w-52 shrink-0 flex-col gap-0.5 self-start lg:flex"
        >
          {SECTIONS.map(({ value, label, icon: Icon }) => (
            <Link
              key={value}
              to="/settings"
              search={value === "profile" ? {} : { section: value }}
              aria-current={value === section ? "page" : undefined}
              className={filterRailRowClassName(value === section)}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </Link>
          ))}
        </nav>
      )}
      <div className="flex min-w-0 max-w-xl flex-1 flex-col items-center gap-6">
        <div className="flex w-full items-center gap-2">
          <Settings className="size-5 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">
            <GradientText>Settings</GradientText>
          </h1>
        </div>

        {!session ? (
          <>
            <LoginPrompt
              title="Log in to manage your account"
              description="Account settings are only available to signed-in users."
            />
            {/* The theme is a per-browser choice, not an account one, so
                it's on offer signed out too. */}
            <AppearanceCard />
          </>
        ) : isDesktop ? (
          // Keyed so switching sections plays the card's entrance again.
          <SectionCard key={section} section={section} />
        ) : (
          <>
            <EditProfileCard />
            <EditStatusCard />
            <AppearanceCard />
            <BlockedUsersCard />
            <BrowserNotificationsCard />
            <ChangePasswordCard />
            <DeleteAccountCard />
          </>
        )}
      </div>
    </main>
  );
}
