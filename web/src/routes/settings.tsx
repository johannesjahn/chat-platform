import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Loader2 } from "lucide-react";
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
import { $api } from "@/lib/api";
import { setSession, useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";

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
        <ChangePasswordCard />
      )}
    </main>
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
              required
            />
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
              mismatch
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
