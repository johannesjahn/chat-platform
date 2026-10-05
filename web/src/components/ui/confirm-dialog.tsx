import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTransitionState } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type ConfirmOptions = {
  title: string;
  // What actually happens if they go ahead — the consequence, not a re-ask.
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // Destructive (the default) paints the confirm button red and shows the
  // warning glyph; turn it off for a confirm that changes rather than
  // destroys (e.g. handing over chat ownership).
  destructive?: boolean;
};

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

// The in-app replacement for `window.confirm` (issue #507): resolves `true`
// when the user confirms and `false` when they cancel, press Escape, or click
// the backdrop. Needs a `<ConfirmProvider>` above it (mounted once in
// __root.tsx).
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return confirm;
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // The last request stays rendered while the dialog animates out, after
  // `pending` has already been cleared.
  const [shown, setShown] = useState<ConfirmOptions | null>(null);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setPending((prev) => {
          // A second request while one is open supersedes it — the first
          // caller is told "no" rather than left hanging forever.
          prev?.resolve(false);
          return { ...options, resolve };
        });
        setShown(options);
      }),
    [],
  );

  const settle = useCallback((ok: boolean) => {
    setPending((prev) => {
      prev?.resolve(ok);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {shown && (
        <ConfirmDialog
          open={pending !== null}
          options={shown}
          onSettle={settle}
          onExited={() => setShown(null)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  open,
  options,
  onSettle,
  onExited,
}: {
  open: boolean;
  options: ConfirmOptions;
  onSettle: (ok: boolean) => void;
  onExited: () => void;
}) {
  const {
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    destructive = true,
  } = options;
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const {
    ref: panelRef,
    phase,
    mounted,
  } = useTransitionState<HTMLDivElement>(open);

  useEffect(() => {
    if (!mounted) onExited();
  }, [mounted, onExited]);

  // Focus starts on Cancel — the safe choice — and goes back to whatever was
  // focused before (usually the button that asked) once the dialog closes.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, [open]);

  // Escape cancels, and Tab stays inside the dialog. Captured on `window` and
  // stopped there, so a dialog this one sits on top of (group settings closes
  // on its own Escape listener) doesn't also react to the same key press.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onSettle(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled])",
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onSettle, panelRef]);

  if (!mounted) return null;
  const exiting = phase === "exiting";

  return (
    <div
      // Above every other overlay (group settings and friends sit at z-50),
      // since a confirm is usually raised from inside one of them.
      className="fixed inset-0 z-[70] flex items-end justify-center p-4 sm:items-center"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      inert={!open}
    >
      <div
        className={cn(
          "absolute inset-0 bg-background/70 backdrop-blur-sm",
          exiting
            ? "motion-safe:animate-backdrop-fade-out"
            : "motion-safe:animate-backdrop-blur-in",
        )}
        onClick={() => onSettle(false)}
      />
      <div
        ref={panelRef}
        className={cn(
          "relative w-full max-w-sm rounded-3xl border border-border bg-card p-6 shadow-2xl",
          exiting
            ? "motion-safe:animate-pop-close"
            : "motion-safe:animate-dialog-in",
        )}
      >
        <div className="flex items-start gap-4">
          {destructive && (
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="size-5" />
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 id={titleId} className="text-base font-semibold leading-snug">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            onClick={() => onSettle(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={() => onSettle(true)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
