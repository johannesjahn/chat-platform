import { useRef, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Bell,
  BellOff,
  ImageUp,
  KeyRound,
  Loader2,
  Palette,
  Shield,
  Smile,
  Trash2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Avatar, type AvatarVariants } from "@/components/Avatar";
import { AvatarCropDialog } from "@/components/AvatarCropDialog";
import { filterRailRowClassName } from "@/components/filterRailStyles";
import { LoginPrompt } from "@/components/LoginPrompt";
import { GradientText } from "@/components/reactbits/GradientText";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  $api,
  blocksQueryKey,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_STATUS_EMOJI_LENGTH,
  MAX_STATUS_TEXT_LENGTH,
  MIN_PASSWORD_LENGTH,
  usersQueryKey,
} from "@/lib/api";
import { clearSession, setSession, useSession } from "@/lib/auth";
import {
  setBrowserNotifications,
  useBrowserNotificationState,
} from "@/lib/browserNotifications";
import { useIsDesktop } from "@/lib/media";
import { errorMessage } from "@/lib/errors";
import { formatBytes } from "@/lib/attachments";
import {
  MAX_AVATAR_UPLOAD_SIZE_BYTES,
  isAllowedAvatarFile,
  uploadAvatar,
} from "@/lib/avatar";
import { setThemePreference, THEME_OPTIONS, useTheme } from "@/lib/theme";
import { staticTitle } from "@/lib/title";
import { userHandle, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

type Section =
  | "profile"
  | "status"
  | "appearance"
  | "privacy"
  | "notifications"
  | "password"
  | "account";

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
    SECTIONS.some((s) => s.value === search.section)
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
          <KeyRound className="size-5 text-primary" />
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

// Light, dark, or whatever the OS prefers (issue #315) — see lib/theme.ts.
// The header toggle steps through the same three; this spells them out.
function AppearanceCard() {
  const { preference, resolved } = useTheme();

  return (
    <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Choose a light or dark theme, or follow your device&apos;s setting.
          Applies to this browser only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-3 gap-2"
        >
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const selected = value === preference;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setThemePreference(value)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-5" />
                {label}
              </button>
            );
          })}
        </div>
        {preference === "system" && (
          <p className="text-sm text-muted-foreground">
            Your device is currently set to {resolved}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Opt-in system notifications for new messages and notifications while the
// tab is in the background (issue #554) — see lib/browserNotifications.ts.
function BrowserNotificationsCard() {
  const state = useBrowserNotificationState();
  const [pending, setPending] = useState(false);

  async function toggle() {
    setPending(true);
    try {
      await setBrowserNotifications(state !== "on");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>Desktop notifications</CardTitle>
        <CardDescription>
          Get a system notification for new messages and notifications while
          this tab is in the background. Applies to this browser only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {state === "unsupported"
            ? "This browser doesn't support notifications."
            : state === "denied"
              ? "Notifications are blocked for this site in your browser's settings."
              : state === "on"
                ? "On — you'll be notified while the tab is hidden."
                : "Off"}
        </p>
        <Button
          variant={state === "on" ? "outline" : "default"}
          size="sm"
          disabled={pending || state === "unsupported" || state === "denied"}
          onClick={() => void toggle()}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : state === "on" ? (
            <BellOff className="size-4" />
          ) : (
            <Bell className="size-4" />
          )}
          {state === "on" ? "Turn off" : "Turn on"}
        </Button>
      </CardContent>
    </Card>
  );
}

// Options for how long a newly-set status stays visible before it's treated
// as unset (see `effectiveStatus` in src/UsersHandler.ts) — a native
// `<select>`'s value is always a string, so "never" stands in for "no
// `expiresInMinutes`" rather than using an empty string (which HTML selects
// otherwise use as their fallback/placeholder value).
const STATUS_EXPIRY_OPTIONS = [
  { value: "never", label: "Doesn't expire" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
  { value: "1440", label: "24 hours" },
] as const;

function EditStatusCard() {
  const session = useSession();
  const updateStatus = $api.useMutation("put", "/users/me/status");

  const [statusText, setStatusText] = useState(session?.user.statusText ?? "");
  const [statusEmoji, setStatusEmoji] = useState(
    session?.user.statusEmoji ?? "",
  );
  const [expiresIn, setExpiresIn] = useState<string>("never");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const hasDraftStatus =
    statusText.trim().length > 0 || statusEmoji.trim().length > 0;
  const hasExistingStatus = !!(
    session?.user.statusText || session?.user.statusEmoji
  );

  async function handleClear() {
    setError(null);
    setSuccess(false);
    if (!session) return;
    try {
      const updated = await updateStatus.mutateAsync({
        body: { statusText: null, statusEmoji: null },
      });
      setSession({ ...session, user: updated });
      setStatusText("");
      setStatusEmoji("");
      setExpiresIn("never");
      setSuccess(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>Status</CardTitle>
        <CardDescription>
          Let people know what you&apos;re up to — shown next to your name in
          chats and on your profile.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {success && (
          <p className="mb-4 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary">
            Status updated.
          </p>
        )}
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setSuccess(false);
            if (!session) return;
            try {
              const updated = await updateStatus.mutateAsync({
                body: {
                  statusText: statusText.trim() || null,
                  statusEmoji: statusEmoji.trim() || null,
                  ...(hasDraftStatus && expiresIn !== "never"
                    ? { expiresInMinutes: Number(expiresIn) }
                    : {}),
                },
              });
              setSession({ ...session, user: updated });
              setSuccess(true);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <div className="flex gap-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="status-emoji">Emoji</Label>
              <Input
                id="status-emoji"
                placeholder="🎯"
                value={statusEmoji}
                onChange={(e) => setStatusEmoji(e.target.value)}
                maxLength={MAX_STATUS_EMOJI_LENGTH}
                className="w-16 text-center"
              />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="status-text">Status message</Label>
              <Input
                id="status-text"
                placeholder="In a meeting"
                value={statusText}
                onChange={(e) => setStatusText(e.target.value)}
                maxLength={MAX_STATUS_TEXT_LENGTH}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="status-expiry">Clear after</Label>
            <select
              id="status-expiry"
              value={expiresIn}
              onChange={(e) => setExpiresIn(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {STATUS_EXPIRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              type="submit"
              className="flex-1"
              disabled={updateStatus.isPending || !hasDraftStatus}
            >
              {updateStatus.isPending && (
                <Loader2 className="size-4 animate-spin" />
              )}
              Save status
            </Button>
            {hasExistingStatus && (
              <Button
                type="button"
                variant="outline"
                disabled={updateStatus.isPending}
                onClick={() => void handleClear()}
              >
                Clear
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// Lists everyone the current user has blocked or muted (issue #219) with a
// control to lift each relationship. Blocking hides a user's posts, mutes
// their chat notifications, and stops direct messaging both ways; muting only
// hides posts and mutes notifications. New blocks/mutes are added from a
// user's profile page (see BlockUserControls), so this card is management-only.
function BlockedUsersCard() {
  const queryClient = useQueryClient();
  const { data: blocks, isLoading } = $api.useQuery("get", "/users/me/blocks");
  const removeBlock = $api.useMutation("delete", "/users/{id}/block");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);

  async function lift(userId: number) {
    setError(null);
    setPendingId(userId);
    try {
      await removeBlock.mutateAsync({
        params: { path: { id: String(userId) } },
      });
      await queryClient.invalidateQueries({ queryKey: blocksQueryKey });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>Blocked &amp; muted users</CardTitle>
        <CardDescription>
          Blocking hides someone&apos;s posts, silences their chat
          notifications, and stops direct messages both ways. Muting just hides
          their posts and notifications. Add new ones from a user&apos;s
          profile.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : !blocks || blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You haven&apos;t blocked or muted anyone.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {blocks.map((block) => (
              <li
                key={block.user.id}
                className="flex items-center justify-between gap-3"
              >
                <Link
                  to="/users/$id"
                  params={{ id: String(block.user.id) }}
                  className="flex min-w-0 items-center gap-3"
                >
                  <Avatar
                    name={block.user.displayName || block.user.username}
                    avatarUrl={block.user.avatarUrl}
                    avatarVariants={block.user.avatarVariants}
                    size="sm"
                  />
                  <div className="flex min-w-0 flex-col leading-tight">
                    <span className="truncate text-sm font-medium">
                      {userLabel(block.user)}
                      {userHandle(block.user) && (
                        <span className="ml-1.5 font-normal text-muted-foreground">
                          {userHandle(block.user)}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      {block.type === "block" ? (
                        <Ban className="size-3" />
                      ) : (
                        <BellOff className="size-3" />
                      )}
                      {block.type === "block" ? "Blocked" : "Muted"}
                    </span>
                  </div>
                </Link>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pendingId === block.user.id}
                  onClick={() => void lift(block.user.id)}
                >
                  {pendingId === block.user.id && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  {block.type === "block" ? "Unblock" : "Unmute"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function EditProfileCard() {
  const session = useSession();
  const queryClient = useQueryClient();
  const updateProfile = $api.useMutation("put", "/users/me");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [displayName, setDisplayName] = useState(
    session?.user.displayName ?? "",
  );
  const [avatarUrl, setAvatarUrl] = useState(session?.user.avatarUrl ?? "");
  const [avatarVariants, setAvatarVariants] = useState<AvatarVariants | null>(
    session?.user.avatarVariants ?? null,
  );
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const hasAvatar = !!avatarVariants || avatarUrl.trim().length > 0;

  async function removeAvatar() {
    setError(null);
    setSuccess(false);
    if (!session) return;
    try {
      // A full-replace `updateProfile` with `avatarUrl: null` clears both the
      // linked URL and any uploaded avatar (they're mutually exclusive
      // server-side — see UsersHandler.ts), so this is a real "remove" rather
      // than just clearing the URL field.
      const updated = await updateProfile.mutateAsync({
        body: { displayName: displayName.trim() || null, avatarUrl: null },
      });
      setSession({ ...session, user: updated });
      setAvatarUrl("");
      setAvatarVariants(null);
      await queryClient.invalidateQueries({ queryKey: usersQueryKey });
      setSuccess(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>Edit profile</CardTitle>
        <CardDescription>Update your display name and avatar.</CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {success && (
          <p className="mb-4 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary">
            Profile updated.
          </p>
        )}
        {cropFile && (
          <AvatarCropDialog
            file={cropFile}
            onClose={() => setCropFile(null)}
            upload={uploadAvatar}
            onUploaded={async (updated) => {
              setCropFile(null);
              setAvatarUrl(updated.avatarUrl ?? "");
              setAvatarVariants(updated.avatarVariants);
              if (session) setSession({ ...session, user: updated });
              await queryClient.invalidateQueries({ queryKey: usersQueryKey });
              setSuccess(true);
            }}
          />
        )}
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setSuccess(false);
            if (!session) return;
            try {
              const updated = await updateProfile.mutateAsync({
                body: {
                  displayName: displayName.trim() || null,
                  avatarUrl: avatarUrl.trim() || null,
                },
              });
              setSession({ ...session, user: updated });
              // A full-replace `updateProfile` always clears any uploaded
              // avatar server-side (see UsersHandler.ts) — reflect that here
              // rather than leaving a stale preview.
              setAvatarVariants(updated.avatarVariants);
              await queryClient.invalidateQueries({ queryKey: usersQueryKey });
              setSuccess(true);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <div className="flex items-center gap-4">
            <Avatar
              name={displayName.trim() || session?.user.username || ""}
              avatarUrl={avatarUrl.trim() || null}
              avatarVariants={avatarVariants}
              size="lg"
            />
            <div className="flex flex-1 flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  setError(null);
                  if (!isAllowedAvatarFile(file)) {
                    setError("Avatars must be a JPEG, PNG, or WebP image.");
                    return;
                  }
                  if (file.size > MAX_AVATAR_UPLOAD_SIZE_BYTES) {
                    setError(
                      `File exceeds the ${formatBytes(MAX_AVATAR_UPLOAD_SIZE_BYTES)} limit`,
                    );
                    return;
                  }
                  setCropFile(file);
                }}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageUp className="size-4" />
                  Upload avatar
                </Button>
                {hasAvatar && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start text-destructive hover:text-destructive"
                    disabled={updateProfile.isPending}
                    onClick={() => void removeAvatar()}
                  >
                    <Trash2 className="size-4" />
                    Remove photo
                  </Button>
                )}
              </div>
              <Label htmlFor="avatar-url">Or link an image URL</Label>
              <Input
                id="avatar-url"
                type="url"
                placeholder="https://example.com/avatar.png"
                value={avatarUrl}
                onChange={(e) => {
                  setAvatarUrl(e.target.value);
                  // Typing a URL here means "use this instead of the
                  // uploaded avatar" — updateProfile enforces the same
                  // mutual exclusivity server-side on submit.
                  setAvatarVariants(null);
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Username</Label>
            <p className="text-sm text-muted-foreground">
              @{session?.user.username}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="display-name">Display name</Label>
            <Input
              id="display-name"
              placeholder="Optional"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
            />
          </div>
          <Button
            type="submit"
            className="mt-1 w-full"
            disabled={updateProfile.isPending}
          >
            {updateProfile.isPending && (
              <Loader2 className="size-4 animate-spin" />
            )}
            {updateProfile.isPending ? "Please wait…" : "Save profile"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangePasswordCard() {
  const session = useSession();
  const changePassword = $api.useMutation("post", "/users/me/password");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const mismatch =
    confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort =
    newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;

  return (
    <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          Changing your password signs you out of every other device.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {success && (
          <p className="mb-4 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary">
            Password changed.
          </p>
        )}
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setSuccess(false);
            if (newPassword.length < MIN_PASSWORD_LENGTH) {
              setError(
                `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
              );
              return;
            }
            if (newPassword !== confirmPassword) {
              setError("New passwords don't match.");
              return;
            }
            if (!session) return;
            try {
              const { accessToken, refreshToken } =
                await changePassword.mutateAsync({
                  body: { currentPassword, newPassword },
                });
              setSession({ ...session, accessToken, refreshToken });
              setCurrentPassword("");
              setNewPassword("");
              setConfirmPassword("");
              setSuccess(true);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
            {tooShort && (
              <p className="text-sm text-destructive">
                New password must be at least {MIN_PASSWORD_LENGTH} characters.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
            {mismatch && (
              <p className="text-sm text-destructive">
                New passwords don&apos;t match.
              </p>
            )}
          </div>
          <Button
            type="submit"
            className="mt-1 w-full"
            disabled={
              changePassword.isPending ||
              !currentPassword ||
              !newPassword ||
              !confirmPassword ||
              mismatch ||
              tooShort
            }
          >
            {changePassword.isPending && (
              <Loader2 className="size-4 animate-spin" />
            )}
            {changePassword.isPending ? "Please wait…" : "Change password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function DeleteAccountCard() {
  const session = useSession();
  const router = useRouter();
  const deleteAccount = $api.useMutation("delete", "/users/me");
  const confirm = useConfirm();

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="w-full border-destructive/40 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <Trash2 className="size-4" />
          Delete account
        </CardTitle>
        <CardDescription>
          Permanently deletes your account, posts, comments, and messages. This
          can&apos;t be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            if (!session) return;
            const ok = await confirm({
              title: "Delete your account?",
              description:
                "Your profile, posts, comments, and messages are permanently removed and you'll be signed out. This can't be undone.",
              confirmLabel: "Delete account",
            });
            if (!ok) return;
            try {
              await deleteAccount.mutateAsync({ body: { password } });
              clearSession();
              await router.navigate({ to: "/" });
              router.invalidate();
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="delete-password">Confirm your password</Label>
            <Input
              id="delete-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button
            type="submit"
            variant="destructive"
            className="mt-1 w-full"
            disabled={deleteAccount.isPending || !password}
          >
            {deleteAccount.isPending && (
              <Loader2 className="size-4 animate-spin" />
            )}
            {deleteAccount.isPending ? "Please wait…" : "Delete my account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
