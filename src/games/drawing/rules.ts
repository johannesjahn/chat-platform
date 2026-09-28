import type { DrawingLobbySettings } from "../../db/schema.ts";
import { DRAWING_PACKS } from "./packs/index.ts";

// Sketchy's lobby bounds. Fewer than three and bluffing doesn't work (the
// only other voter would always know whose fake is whose); more than eight
// and a round drags.
export const DRAWING_MIN_PLAYERS = 3;
export const DRAWING_MAX_PLAYERS = 8;
export const DRAWING_COUNTDOWN_MS = 4_000;

// A draw submitted this long after its stage's timer still counts: the
// client sends whatever is on the canvas when time runs out, and that
// request can land a moment late. (Bluffs and votes get no grace — they
// change the ballot and the scores, which other players may already be
// looking at.)
export const DRAWING_SUBMIT_GRACE_MS = 2_000;

export const DEFAULT_DRAWING_SETTINGS: DrawingLobbySettings = {
  packs: [DRAWING_PACKS[0]!.slug],
  rounds: 1,
};
