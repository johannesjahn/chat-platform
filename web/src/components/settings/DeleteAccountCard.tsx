import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Loader2, Trash2 } from "lucide-react";
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
import { $api } from "@/lib/api";
import { clearSession, useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";

export function DeleteAccountCard() {
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
