import { cn } from "@/lib/utils";

// Shared with rails whose rows are links rather than buttons (settings).
export function filterRailRowClassName(active: boolean) {
  return cn(
    "relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "bg-primary/10 text-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  );
}
