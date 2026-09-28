import type { CSSProperties, ReactNode } from "react";
import { Check, Pencil } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";
import { castLabel, type Cast } from "@/lib/games/cast";
import { userAvatarName } from "@/lib/users";

export function CastAvatar({
  cast,
  userId,
  size = "sm",
  className,
  style,
}: {
  cast: Cast;
  userId: number;
  size?: "sm" | "md" | "lg";
  className?: string;
  style?: CSSProperties;
}) {
  const user = cast.get(userId);
  return (
    <span title={castLabel(cast, userId)} className={className} style={style}>
      <Avatar
        name={user ? userAvatarName(user) : "?"}
        avatarUrl={user?.avatarUrl ?? null}
        avatarVariants={user?.avatarVariants ?? null}
        size={size}
      />
    </span>
  );
}

// "3 of 5 in" as a row of dots that fill (with a pop) as submissions land —
// all a client is ever told about who has bluffed or voted is the count.
export function SubmissionProgress({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="flex gap-1"
      >
        {Array.from({ length: total }, (_, i) => (
          <span
            key={`${i}-${i < done}`}
            className={cn(
              "size-2.5 rounded-full transition-colors duration-300",
              i < done
                ? "game-gradient shadow-[0_0_8px_var(--game-glow)] motion-safe:animate-badge-pop"
                : "bg-muted",
            )}
          />
        ))}
      </span>
      <span className="tabular-nums">
        {done} of {total} {label}
      </span>
    </div>
  );
}

// Who's finished drawing: every participant's avatar, a check popping onto
// each as their drawing comes in (whether a drawing is in is public; what's
// on it isn't).
export function DrawRoster({
  cast,
  artists,
}: {
  cast: Cast;
  artists: ReadonlyArray<{ artistId: number; submitted: boolean }>;
}) {
  return (
    <ul className="flex flex-wrap justify-center gap-3" aria-label="Artists">
      {artists.map(({ artistId, submitted }, index) => (
        <li
          key={artistId}
          style={{ "--stagger-index": index } as CSSProperties}
          className="relative flex flex-col items-center gap-1 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90 motion-safe:fill-mode-both stagger-in"
        >
          <CastAvatar
            cast={cast}
            userId={artistId}
            size="md"
            className={cn(
              "rounded-full transition-[filter,opacity] duration-500",
              !submitted && "opacity-60 grayscale",
            )}
          />
          <span
            className={cn(
              "absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border-2 border-card",
              submitted
                ? "bg-emerald-500 text-white motion-safe:animate-badge-pop"
                : "bg-muted text-muted-foreground",
            )}
          >
            {submitted ? (
              <Check className="size-3" strokeWidth={3} />
            ) : (
              <Pencil className="size-2.5 motion-safe:animate-pencil-scribble" />
            )}
          </span>
          <span className="max-w-20 truncate text-[11px] text-muted-foreground">
            {castLabel(cast, artistId)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// A little pencil scribbling a line — "others are still at it".
export function WaitingPencil({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-2 text-center text-sm text-muted-foreground">
      <span className="relative h-8 w-16" aria-hidden>
        <Pencil className="absolute left-0 top-0 size-6 text-[var(--game-from)] motion-safe:animate-pencil-scribble" />
        <span className="absolute bottom-1 left-1 h-0.5 w-12 rounded-full bg-[color-mix(in_oklch,var(--game-from),transparent_50%)]" />
      </span>
      {children}
    </div>
  );
}
