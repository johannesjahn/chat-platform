import { cn } from "@/lib/utils";

export type PresenceDotProps = {
  online: boolean;
  className?: string;
};

// A small "is this user online right now" indicator (see web/src/lib/presence.ts) —
// a solid dot with a soft expanding ring animating outward behind it while
// online, the same "alive" pulse convention Slack/Discord/WhatsApp all use.
// Collapses to a plain muted dot the moment presence flips offline.
export function PresenceDot({ online, className }: PresenceDotProps) {
  return (
    <span
      className={cn("relative inline-flex size-2.5 shrink-0", className)}
      aria-hidden="true"
    >
      {online && (
        <span className="absolute inset-0 rounded-full bg-emerald-400 motion-safe:animate-presence-ping" />
      )}
      <span
        className={cn(
          "relative inline-flex size-2.5 rounded-full border-2 border-card transition-colors duration-300",
          online ? "bg-emerald-400" : "bg-muted-foreground/40",
        )}
      />
    </span>
  );
}
