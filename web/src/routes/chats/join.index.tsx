import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Link2 } from "lucide-react";
import { LoginPrompt } from "@/components/LoginPrompt";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/auth";

export const Route = createFileRoute("/chats/join/")({
  component: JoinChatPage,
});

// Invite links are shaped like `<origin>/chats/join/<code>` — this page also
// accepts a bare code (or a pasted full link) typed in by hand, and forwards
// to `/chats/join/$code` either way, which is what actually redeems it
// (issue #220).
function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  const lastSegment = trimmed.split("/").filter(Boolean).pop();
  return lastSegment ?? trimmed;
}

function JoinChatPage() {
  const session = useSession();
  const router = useRouter();
  const [value, setValue] = useState("");

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-xl justify-center px-4 py-10">
        <LoginPrompt
          title="Log in to join a chat"
          description="You need an account to redeem an invite link."
        />
      </main>
    );
  }

  const code = extractInviteCode(value);

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Link2 className="size-4 text-primary" />
            Join a chat
          </CardTitle>
          <CardDescription>
            Paste an invite link or code someone shared with you.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-code">Invite link or code</Label>
            <Input
              id="invite-code"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="https://…/chats/join/abcd1234 or abcd1234"
              autoFocus
            />
          </div>
          <Button
            type="button"
            className="w-full"
            disabled={code.length === 0}
            onClick={() =>
              void router.navigate({
                to: "/chats/join/$code",
                params: { code },
              })
            }
          >
            Continue
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
