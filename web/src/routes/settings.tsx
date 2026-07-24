import { useRef, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ImageUp, KeyRound, Loader2, Trash2 } from "lucide-react";
import { Avatar, type AvatarVariants } from "@/components/Avatar";
import { AvatarCropDialog } from "@/components/AvatarCropDialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  $api,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_STATUS_EMOJI_LENGTH,
  MAX_STATUS_TEXT_LENGTH,
  MIN_PASSWORD_LENGTH,
  usersQueryKey,
} from "@/lib/api";
import { clearSession, setSession, useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { formatBytes } from "@/lib/attachments";
import {
  MAX_AVATAR_UPLOAD_SIZE_BYTES,
  isAllowedAvatarFile,
} from "@/lib/avatar";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const session = useSession();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-10">
      <div className="flex w-full items-center gap-2">
        <KeyRound className="size-5 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">
          <GradientText>Settings</GradientText>
        </h1>
      </div>

      {!session ? (
        <LoginPrompt
          title="Log in to manage your account"
          description="Account settings are only available to signed-in users."
        />
      ) : (
        <>
          <EditProfileCard />
          <EditStatusCard />
          <ChangePasswordCard />
          <DeleteAccountCard />
        </>
      )}
    </main>
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
            if (
              !window.confirm(
                "Delete your account permanently? This can't be undone.",
              )
            ) {
              return;
            }
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
