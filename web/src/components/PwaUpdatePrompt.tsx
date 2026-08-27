import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwaUpdate } from "@/lib/pwa";

// Small banner that appears once a new version of the app has been
// installed in the background, prompting the user to reload and pick it up.
export function PwaUpdatePrompt() {
  const { needRefresh, updateApp } = usePwaUpdate();

  if (!needRefresh) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4">
      {/* The same spring the offline banner drops in on, mirrored: this one
          rises off the bottom edge and settles. */}
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-lg motion-safe:animate-banner-rise">
        <span className="text-sm text-foreground">
          A new version is available.
        </span>
        <Button size="sm" onClick={updateApp}>
          <RefreshCw className="size-4" />
          Reload
        </Button>
      </div>
    </div>
  );
}
