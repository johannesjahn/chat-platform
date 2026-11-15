import { useState } from "react";
import { Loader2 } from "lucide-react";
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
  MAX_STATUS_EMOJI_LENGTH,
  MAX_STATUS_TEXT_LENGTH,
} from "@/lib/api";
import { setSession, useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";

// Options for how long a newly-set status stays visible before it's treated
// as unset (see `effectiveStatus` in src/users/userViews.ts) — a native
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

export function EditStatusCard() {
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
