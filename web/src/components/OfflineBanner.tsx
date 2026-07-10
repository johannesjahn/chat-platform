import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/lib/online";

// Sits alongside PwaUpdatePrompt near the root: a persistent-but-unobtrusive
// signal that reads made while offline are serving whatever was already
// persisted/cached, not live data, and that sends (see ChatComposer,
// PostForm) are disabled rather than silently failing.
export function OfflineBanner() {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-400"
    >
      <WifiOff className="size-3.5" />
      You&apos;re offline — showing previously loaded content.
    </div>
  );
}
