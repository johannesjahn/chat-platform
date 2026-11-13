import { useEffect, useId, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTransitionState } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ConfirmOptions } from "./confirm-dialog";

export type ConfirmDialogProps = {
  open: boolean;
  options: ConfirmOptions;
  onSettle: (ok: boolean) => void;
  onExited: () => void;
};

// The dialog `useConfirm` raises — loaded on demand by `ConfirmProvider`
// (confirm-dialog.tsx), which owns the request it answers.
export function ConfirmDialog({
  open,
  options,
  onSettle,
  onExited,
}: ConfirmDialogProps) {
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
      className="overlay-viewport z-[70] flex items-end justify-center px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:items-center"
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
