import type { ReactNode } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { backLabel, backOrigin, canGoBackTo } from "@/lib/backOrigin";
import { cn } from "@/lib/utils";

/**
 * A page's "Back" control (issues #762, #907). Opened from somewhere in the
 * app (a profile, search, a notification…), it says where it goes and
 * returns there through history, scroll position and all. A direct load, a
 * new tab or a shared link has nowhere to go back to, so it renders
 * `fallback` instead — a `<Link>` with an arrow and its own label.
 *
 * The page's only way out in an installed PWA, which has no browser back
 * button.
 */
export function BackButton({
  fallback,
  className,
}: {
  fallback: ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const location = useLocation();
  const origin = backOrigin(location);
  const canGoBack = canGoBackTo(router, origin);

  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className={cn("self-start", className)}
    >
      {canGoBack ? (
        // A real link to the origin (so it opens in a new tab like any
        // other), but a plain click steps back through history rather than
        // pushing a new entry.
        <a
          href={origin ?? "/"}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            router.history.back();
          }}
        >
          <ArrowLeft className="size-4" />
          {backLabel(origin)}
        </a>
      ) : (
        fallback
      )}
    </Button>
  );
}
