import {
  Crosshair,
  Ghost,
  Move,
  Shapes,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { ReflexKind } from "@/lib/games/reflex";

// Each round kind's glyph, wherever a round is named — the title card, the
// round track, the results grid, the waiting room's guide.
export const REFLEX_KIND_ICONS: Record<ReflexKind, LucideIcon> = {
  go: Zap,
  decoy: Ghost,
  match: Shapes,
  arrow: Move,
  target: Crosshair,
};
