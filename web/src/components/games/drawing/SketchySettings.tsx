import type { CSSProperties } from "react";
import { Check, Layers } from "lucide-react";
import { SegmentedControl } from "@/components/games/SegmentedControl";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  useDrawingPacks,
  useUpdateDrawingSettings,
  type DrawingPack,
} from "@/lib/games/drawing";
import type { GameLobby } from "@/lib/games/lobby";

const ROUNDS = [
  { value: "1", label: "1 round" },
  { value: "2", label: "2 rounds" },
  { value: "3", label: "3 rounds" },
] as const;

// Sketchy's waiting-room settings: the theme packs, as a grid of cards, and
// the number of rounds. The host's picks save as they're made and reach
// everyone in the lobby live; while one is saving it's already shown, so a
// tap never feels laggy. Everyone else sees the same grid, read-only.
export function SketchySettings({
  lobby,
  isHost,
}: {
  lobby: GameLobby;
  isHost: boolean;
}) {
  const packs = useDrawingPacks(true);
  const update = useUpdateDrawingSettings(lobby.id);
  const saved = lobby.drawing!;
  const shown =
    update.isPending && update.variables
      ? update.variables
      : { packs: [...saved.packs], rounds: saved.rounds };
  const selected = new Set(shown.packs);

  const save = (next: { packs: string[]; rounds: number }) => {
    if (next.packs.length === 0) return;
    update.mutate(next);
  };
  const toggle = (slug: string) =>
    save({
      packs: selected.has(slug)
        ? shown.packs.filter((s) => s !== slug)
        : [...shown.packs, slug],
      rounds: shown.rounds,
    });

  const promptTotal = (packs.data ?? [])
    .filter((pack) => selected.has(pack.slug))
    .reduce((sum, pack) => sum + pack.promptCount, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold">
            <Layers className="size-4 text-[var(--game-from)]" />
            Theme packs
          </h3>
          <p className="text-xs text-muted-foreground">
            {isHost
              ? "Pick one or more — everyone's prompts come from these."
              : "The host picks the packs. Here's what you'll be drawing from."}
          </p>
        </div>
        {isHost ? (
          <SegmentedControl
            label="Rounds"
            options={ROUNDS}
            value={String(shown.rounds) as (typeof ROUNDS)[number]["value"]}
            onChange={(value) =>
              save({ packs: shown.packs, rounds: Number(value) })
            }
          />
        ) : (
          <span className="rounded-full border border-border/70 bg-background/50 px-3 py-1 text-xs font-medium">
            {shown.rounds} {shown.rounds === 1 ? "round" : "rounds"}
          </span>
        )}
      </div>

      {packs.isLoading ? (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : (
        <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {(packs.data ?? []).map((pack, index) => (
            <PackCard
              key={pack.slug}
              pack={pack}
              index={index}
              selected={selected.has(pack.slug)}
              editable={isHost}
              lastOne={selected.size === 1 && selected.has(pack.slug)}
              onToggle={() => toggle(pack.slug)}
            />
          ))}
        </ul>
      )}

      <p className="text-center text-xs text-muted-foreground">
        <span
          key={promptTotal}
          className="inline-block font-semibold text-foreground motion-safe:animate-count-tick"
        >
          {promptTotal}
        </span>{" "}
        prompts in play · {shown.rounds}{" "}
        {shown.rounds === 1 ? "drawing" : "drawings"} each
      </p>
      {update.error && (
        <p className="text-center text-sm text-destructive" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
    </div>
  );
}

function PackCard({
  pack,
  index,
  selected,
  editable,
  lastOne,
  onToggle,
}: {
  pack: DrawingPack;
  index: number;
  selected: boolean;
  editable: boolean;
  lastOne: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      style={{ "--stagger-index": index } as CSSProperties}
      className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:fill-mode-both motion-safe:duration-500 stagger-in"
    >
      <button
        type="button"
        aria-pressed={selected}
        disabled={!editable || lastOne}
        title={lastOne && editable ? "At least one pack is needed" : undefined}
        onClick={onToggle}
        className={cn(
          "group relative flex h-full w-full flex-col gap-2 rounded-xl border p-3.5 text-left transition-all duration-300 ease-spring",
          selected
            ? "game-ring border-transparent bg-[color-mix(in_oklch,var(--game-from),transparent_88%)]"
            : "border-border/60 bg-background/40",
          editable &&
            !lastOne &&
            "hover:-translate-y-0.5 hover:shadow-lg hover:shadow-[var(--game-glow)]",
          !editable && !selected && "opacity-50",
          "disabled:cursor-default",
        )}
      >
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="text-2xl transition-transform duration-500 ease-spring group-hover:-rotate-12 group-hover:scale-125"
          >
            {pack.icon}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-semibold">{pack.name}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {pack.promptCount} prompts
            </span>
          </span>
          <span
            key={String(selected)}
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
              selected
                ? "game-gradient border-transparent text-white motion-safe:animate-badge-pop"
                : "border-border",
            )}
          >
            {selected && <Check className="size-3" strokeWidth={3} />}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {pack.description}
        </span>
        <span className="flex flex-wrap gap-1">
          {pack.samples.map((sample) => (
            <span
              key={sample}
              className="rounded-md bg-muted/70 px-1.5 py-0.5 text-[10px] italic text-foreground/70"
            >
              {sample}
            </span>
          ))}
        </span>
      </button>
    </li>
  );
}
