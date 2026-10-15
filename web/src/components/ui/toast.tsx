import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTransitionState } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type ToastOptions = {
  title: string;
  description?: ReactNode;
  // "warning" for an outcome that only partly worked (e.g. a forward that
  // reached some chats but not others).
  tone?: "success" | "warning";
  action?: { label: string; onClick: () => void };
};

type ShowToast = (options: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

// A short, self-dismissing note at the foot of the screen that an action
// finished — for outcomes worth confirming that happened somewhere the user
// isn't looking (issue #601: "Forwarded to 3 chats"). Needs a
// `<ToastProvider>` above it (mounted once in __root.tsx).
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used inside <ToastProvider>");
  return show;
}

// Long enough to read a line or two; a toast with an action stays a little
// longer so there's time to reach for it.
const TOAST_MS = 5000;
const TOAST_WITH_ACTION_MS = 8000;
// Older toasts make way for new ones rather than stacking up the screen.
const MAX_TOASTS = 3;

type Entry = ToastOptions & { id: number; open: boolean };

let nextToastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Entry[]>([]);

  const show = useCallback<ShowToast>((options) => {
    setToasts((prev) => [
      ...prev.slice(-(MAX_TOASTS - 1)),
      { ...options, id: ++nextToastId, open: true },
    ]);
  }, []);

  const close = useCallback((id: number) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, open: false } : t)),
    );
  }, []);
  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* A live region without a `status` role: it has to be mounted before
          a toast is added for screen readers to announce it, and an
          always-present, usually empty `status` would be mistaken for the
          page's real status banners (the offline banner is one). */}
      <div
        aria-live="polite"
        // Above dialogs (z-50) and the confirm dialog (z-70): a toast is
        // often raised as a dialog closes, and must not land behind it.
        // Lifted clear of a chat's composer, which sits on the bottom edge.
        className="pointer-events-none fixed inset-x-0 bottom-24 z-[80] flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((toast) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            onClose={close}
            onExited={remove}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onClose,
  onExited,
}: {
  toast: Entry;
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
