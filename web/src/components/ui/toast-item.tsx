import { useEffect } from "react";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTransitionState } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ToastEntry } from "./toast";

// Long enough to read a line or two; a toast with an action stays a little
// longer so there's time to reach for it.
const TOAST_MS = 5000;
const TOAST_WITH_ACTION_MS = 8000;

// One toast — loaded on demand by `ToastProvider` (toast.tsx), which keeps
// the list it's drawn from.
export function ToastItem({
  toast,
  onClose,
  onExited,
}: {
  toast: ToastEntry;
  onClose: (id: number) => void;
  onExited: (id: number) => void;
}) {
  const { ref, phase, mounted } = useTransitionState<HTMLDivElement>(
    toast.open,
  );
  const { id, open, action } = toast;

  useEffect(() => {
    if (!mounted) onExited(id);
  }, [mounted, onExited, id]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(
      () => onClose(id),
      action ? TOAST_WITH_ACTION_MS : TOAST_MS,
    );
    return () => clearTimeout(timer);
  }, [open, onClose, id, action]);

  if (!mounted) return null;
  const warning = toast.tone === "warning";
  const Icon = warning ? AlertTriangle : CheckCircle2;

  return (
    <div
      ref={ref}
      data-testid="toast"
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-border bg-popover px-4 py-3 text-popover-foreground shadow-lg",
        phase === "exiting"
          ? "motion-safe:animate-pop-close"
          : "motion-safe:animate-banner-rise",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          warning ? "text-amber-500" : "text-primary",
        )}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium">{toast.title}</p>
        {toast.description && (
          <div className="text-xs text-muted-foreground">
            {toast.description}
          </div>
        )}
      </div>
      {action && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0"
          onClick={() => {
            action.onClick();
            onClose(id);
          }}
        >
          {action.label}
        </Button>
      )}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Dismiss"
        className="-mr-1 size-6 shrink-0"
        onClick={() => onClose(id)}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
