import { absurdPack } from "./absurd.ts";
import { animalsPack } from "./animals.ts";
import { classicsPack } from "./classics.ts";
import { fantasyPack } from "./fantasy.ts";
import { foodPack } from "./food.ts";
import { moviesPack } from "./movies.ts";
import { officePack } from "./office.ts";
import type { DrawingPackDefinition } from "./types.ts";

export type { DrawingPackDefinition } from "./types.ts";

// Every pack, in the order the picker lists them. The first is the default
// selection for a new lobby.
export const DRAWING_PACKS: ReadonlyArray<DrawingPackDefinition> = [
  classicsPack,
  animalsPack,
  foodPack,
  moviesPack,
  officePack,
  fantasyPack,
  absurdPack,
];

const BY_SLUG = new Map(DRAWING_PACKS.map((pack) => [pack.slug, pack]));

export const findDrawingPack = (
  slug: string,
): DrawingPackDefinition | undefined => BY_SLUG.get(slug);

// Every distinct prompt across `slugs` — packs can overlap in spirit, and a
// deal must never hand out the same prompt twice.
export const promptPool = (slugs: ReadonlyArray<string>): string[] => [
  ...new Set(slugs.flatMap((slug) => BY_SLUG.get(slug)?.prompts ?? [])),
];
