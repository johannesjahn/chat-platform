import { useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  setBrowserNotifications,
  useBrowserNotificationState,
} from "@/lib/browserNotifications";

// Opt-in system notifications for new messages and notifications while the
// tab is in the background (issue #554) — see lib/browserNotifications.ts.
export function BrowserNotificationsCard() {
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
