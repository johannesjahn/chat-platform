import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ImageUp, Loader2, Trash2 } from "lucide-react";
import { Avatar, type AvatarVariants } from "@/components/Avatar";
import { AvatarCropDialog } from "@/components/AvatarCropDialog";
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
import { Textarea } from "@/components/ui/textarea";
import {
  $api,
  MAX_BIO_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  usersQueryKey,
} from "@/lib/api";
import { setSession, useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { formatBytes } from "@/lib/attachments";
import {
  MAX_AVATAR_UPLOAD_SIZE_BYTES,
  isAllowedAvatarFile,
  uploadAvatar,
} from "@/lib/avatar";

export function EditProfileCard() {
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
  // The session's `User` carries no bio (issue #322) — it comes from the
  // profile itself, the same `GET /users/{id}` query the profile page reads.
  // `bioDraft` stays null until the field is edited, so the textarea shows
  // the stored bio once it loads, and a save before then leaves it alone.
  const ownProfile = $api.useQuery(
    "get",
    "/users/{id}",
    { params: { path: { id: String(session?.user.id ?? "") } } },
    { enabled: !!session },
  );
  const [bioDraft, setBioDraft] = useState<string | null>(null);
  const bio = bioDraft ?? ownProfile.data?.bio ?? "";
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
        <CardDescription>
          Update your display name, avatar, and bio.
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
                  // Omitted (kept as-is) unless the field was edited.
                  ...(bioDraft !== null && { bio: bioDraft.trim() || null }),
                },
              });
              setSession({ ...session, user: updated });
              // A full-replace `updateProfile` always clears any uploaded
              // avatar server-side (see src/users/profileHandlers.ts) — reflect
              // that here rather than leaving a stale preview.
              setAvatarVariants(updated.avatarVariants);
              await queryClient.invalidateQueries({ queryKey: usersQueryKey });
              await queryClient.invalidateQueries({
                queryKey: ["get", "/users/{id}"],
              });
              setBioDraft(null);
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
            <p className="text-sm text-muted-foreground wrap-anywhere">
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
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="bio">Bio</Label>
              <span className="text-xs text-muted-foreground tabular-nums">
                {bio.length}/{MAX_BIO_LENGTH}
              </span>
            </div>
            <Textarea
              id="bio"
              placeholder="A line or two about yourself (optional)"
              value={bio}
              onChange={(e) => setBioDraft(e.target.value)}
              maxLength={MAX_BIO_LENGTH}
              rows={3}
              className="min-h-20 resize-none"
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
