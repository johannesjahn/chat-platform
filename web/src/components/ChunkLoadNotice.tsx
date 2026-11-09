import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChunkLoadFailed } from "@/lib/lazy";

// Shown once a lazily loaded part of the app (the sidebar, the messaging
// dock, an overlay) has failed to load for good (issue #738) — the page
// itself keeps working, but only a reload brings that part back. Kept out of
// the lazy shell pieces itself, so it can't be the thing that failed.
export function ChunkLoadNotice() {
  const failed = useChunkLoadFailed();

  if (!failed) return null;

  return (
    // Placed like PwaUpdatePrompt: the bottom edge on a phone, the top from
    // `lg` up, where the bottom belongs to the messaging dock.
    <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4 lg:bottom-auto lg:top-0 lg:pb-0 lg:pt-4">
      <div
        role="alert"
        className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-lg motion-safe:animate-banner-rise"
      >
        <span className="text-sm text-foreground">
          Part of the app didn&apos;t finish loading.
        </span>
        <Button size="sm" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" />
          Reload
        </Button>
      </div>
    </div>
  );
}
