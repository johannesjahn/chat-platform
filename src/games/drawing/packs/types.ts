// A Sketchy theme pack. Packs ship as code, not rows (like the typing race's
// passage bank): adding one is a PR — a new file here plus an entry in
// `DRAWING_PACKS` (index.ts) — with no migration and nothing to moderate.
//
// Prompts are plain ASCII, family-friendly, lowercase-first phrases that
// read naturally after "Draw…", and small enough to sketch in 75 seconds:
// one subject doing one silly thing beats a whole scene. Aim for 60+ per
// pack so a full game (8 players x 3 rounds) never runs dry — the tests in
// packs.test.ts hold every pack to that.
export type DrawingPackDefinition = {
  readonly slug: string;
  readonly name: string;
  // A single emoji — rendered as-is by the pack picker.
  readonly icon: string;
  readonly description: string;
  readonly prompts: ReadonlyArray<string>;
};
