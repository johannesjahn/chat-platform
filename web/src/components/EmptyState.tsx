import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Optional call-to-action(s) rendered below the copy. */
  children?: ReactNode;
  className?: string;
};

// A friendly, lightly animated "nothing here yet" panel shared across the
// feed, chats and user-search screens. The glyph sits inside a soft gradient
// disc with a slowly rotating conic sheen behind it, so an empty screen still
// reads as intentional and alive rather than broken. All motion is gated
// behind `motion-safe` / the reduced-motion opt-out in styles.css.
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center gap-4 px-4 py-14 text-center",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500",
        className,
      )}
    >
      <div className="relative flex size-20 items-center justify-center">
        {/* Rotating conic sheen — purely decorative. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full opacity-70 blur-md motion-safe:animate-spin-slow"
          style={{
            background:
              "conic-gradient(from 0deg, oklch(0.62 0.19 277 / 0.35), oklch(0.72 0.14 210 / 0.25), transparent 55%, oklch(0.62 0.19 277 / 0.35))",
          }}
        />
        <span className="relative flex size-16 items-center justify-center rounded-full border border-border bg-card/80 shadow-inner">
          <Icon className="size-7 text-primary motion-safe:animate-float" />
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-base font-semibold tracking-tight">{title}</p>
        {description && (
          <p className="mx-auto max-w-xs text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {children}
        </div>
      )}
    </div>
  );
}
