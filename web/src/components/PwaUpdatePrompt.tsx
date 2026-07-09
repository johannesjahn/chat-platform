import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwaUpdate } from "@/lib/pwa";

// Small banner that appears once a new version of the app has been
// installed in the background, prompting the user to reload and pick it up.
export function PwaUpdatePrompt() {
  const { needRefresh, updateApp } = usePwaUpdate();

  if (!needRefresh) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-300">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-lg">
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
