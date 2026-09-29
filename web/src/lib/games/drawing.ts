import { useEffect, useRef } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { fetchClient } from "@/lib/api";
import type { components } from "@/lib/api-types";
import { gameLobbyQueryKey, primeLobby, unwrap, type GameLobby } from "./lobby";

// Client-side half of Sketchy (the "drawing" game — see src/games/drawing/
// on the backend): the canvas format, stroke geometry, and the hooks for
// every Sketchy endpoint.

export type DrawingGame = components["schemas"]["DrawingGame"];
export type DrawingEntry = components["schemas"]["DrawingEntry"];
export type DrawingAnswer = components["schemas"]["DrawingAnswer"];
export type DrawingStage = components["schemas"]["DrawingStage"];
export type DrawingStageKind = components["schemas"]["DrawingStageKind"];
export type DrawingStroke = components["schemas"]["DrawingStroke"];
export type DrawingBrush = components["schemas"]["DrawingBrush"];
export type DrawingPack = components["schemas"]["DrawingPack"];

// The virtual canvas every stroke is recorded on, and the server's caps on
// a drawing — mirrors of DRAWING_WIDTH/DRAWING_HEIGHT/MAX_DRAWING_POINTS/
// MAX_DRAWING_STROKES/MAX_BLUFF_LENGTH in src/Api.ts (constants don't
// travel through the generated types).
export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;
export const MAX_POINTS = 6000;
export const MAX_STROKES = 400;
export const MAX_BLUFF_LENGTH = 60;

// A stroke stores its color as an index into this list, so it must stay
// exactly DRAWING_PALETTE_SIZE (src/Api.ts) long, and never be reordered —
// that would recolor every drawing already stored.
export const DRAWING_PALETTE: ReadonlyArray<{ name: string; value: string }> = [
  { name: "Ink", value: "#1d1b26" },
  { name: "Chalk", value: "#ffffff" },
  { name: "Cherry", value: "#ef4444" },
  { name: "Tangerine", value: "#f97316" },
  { name: "Sunshine", value: "#facc15" },
  { name: "Leaf", value: "#22c55e" },
  { name: "Sky", value: "#3b82f6" },
  { name: "Grape", value: "#a855f7" },
  { name: "Bubblegum", value: "#ec4899" },
  { name: "Cocoa", value: "#8b5a2b" },
];

export const BRUSH_WIDTH: Record<DrawingBrush, number> = {
  thin: 7,
  thick: 20,
};

// The paper every drawing sits on — always light, in either theme, because
// a drawing is a picture, not UI chrome (ink must stay ink).
export const PAPER = "#fffdf6";

// Consecutive points closer than this (canvas units) add nothing a viewer
// could see, so the canvas drops them — the difference between a 75-second
// sketch costing a few hundred points and a few thousand.
export const MIN_POINT_GAP = 3;

export const pointCount = (strokes: ReadonlyArray<DrawingStroke>): number =>
  strokes.reduce((sum, stroke) => sum + stroke.points.length / 2, 0);

// A stroke's points as a smooth SVG path: a quadratic curve through the
// midpoints of consecutive points, which rounds off the corners pointer
// sampling leaves without drifting from where the pen actually went. A
// single point is a dot (a zero-length line, drawn by its round cap).
export function strokePath(points: ReadonlyArray<number>): string {
  const n = points.length / 2;
  if (n === 0) return "";
  const x = (i: number) => points[i * 2]!;
  const y = (i: number) => points[i * 2 + 1]!;
  if (n === 1) return `M${x(0)} ${y(0)}L${x(0)} ${y(0)}`;
  if (n === 2) return `M${x(0)} ${y(0)}L${x(1)} ${y(1)}`;
  let d = `M${x(0)} ${y(0)}`;
  for (let i = 1; i < n - 1; i++) {
    const midX = (x(i) + x(i + 1)) / 2;
    const midY = (y(i) + y(i + 1)) / 2;
    d += `Q${x(i)} ${y(i)} ${midX} ${midY}`;
  }
  return `${d}L${x(n - 1)} ${y(n - 1)}`;
}

// How long each stroke of a replay takes to draw, and when it starts: in
// proportion to its length, so a scribble replays with the rhythm it was
// drawn with, compressed to fit `totalMs`.
export function replayTimings(
  strokes: ReadonlyArray<DrawingStroke>,
  totalMs: number,
): ReadonlyArray<{ delayMs: number; durationMs: number }> {
  const weights = strokes.map((stroke) =>
    Math.min(Math.max(stroke.points.length / 2, 4), 120),
  );
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0;
  return weights.map((weight) => {
    const durationMs = (weight / sum) * totalMs;
    const timing = { delayMs: cursor, durationMs };
    cursor += durationMs;
    return timing;
  });
}

// --- Export ---------------------------------------------------------------

// A finished drawing as a standalone SVG document: the paper, then every
// stroke, with colors resolved to hex (no CSS classes or custom properties),
// so it renders the same in an image viewer as it does on the page.
export function drawingSvg(strokes: ReadonlyArray<DrawingStroke>): string {
  const paths = strokes
    .map(
      (stroke) =>
        `<path d="${strokePath(stroke.points)}" stroke="${
          DRAWING_PALETTE[stroke.color]?.value ?? "#000"
        }" stroke-width="${BRUSH_WIDTH[stroke.brush]}"/>`,
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}">` +
    `<rect width="100%" height="100%" fill="${PAPER}"/>` +
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`
  );
}

// A safe download name from a prompt: "A cat on a bike!" → "a-cat-on-a-bike".
export function drawingFileName(title: string | null | undefined): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `sketchy-${slug || "drawing"}`;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke on a later tick so the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export type DrawingExportFormat = "png" | "svg";

// Saves a drawing to the user's device, rasterizing to a 2x PNG through a
// canvas (the SVG is self-contained, so nothing taints it) or as vector SVG.
export async function exportDrawing(
  strokes: ReadonlyArray<DrawingStroke>,
  title: string | null | undefined,
  format: DrawingExportFormat,
): Promise<void> {
  const name = drawingFileName(title);
  const svg = drawingSvg(strokes);
  if (format === "svg") {
    saveBlob(new Blob([svg], { type: "image/svg+xml" }), `${name}.svg`);
    return;
  }
  const svgUrl = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml" }),
  );
  try {
    const image = new Image();
    image.src = svgUrl;
    await image.decode();
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH * scale;
    canvas.height = CANVAS_HEIGHT * scale;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!png) throw new Error("Could not encode the image");
    saveBlob(png, `${name}.png`);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

// --- Queries & mutations -------------------------------------------------

export function useDrawingPacks(enabled: boolean) {
  return useQuery({
    queryKey: ["games", "drawing", "packs"],
    enabled,
    // Packs ship with the server; they don't change under a running page.
    staleTime: Infinity,
    queryFn: async () =>
      unwrap(await fetchClient.GET("/games/drawing/packs")).packs,
  });
}

const lobbyPath = (lobbyId: number) => ({
  params: { path: { id: String(lobbyId) } },
});

export function useUpdateDrawingSettings(lobbyId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { packs: string[]; rounds: number }) => {
      const sentAt = Date.now();
      return primeLobby(
        queryClient,
        unwrap(
          await fetchClient.PUT("/games/lobbies/{id}/settings", {
            ...lobbyPath(lobbyId),
            body,
          }),
        ),
        sentAt,
      );
    },
  });
}

export function useSubmitDrawing(lobbyId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (strokes: DrawingStroke[]) => {
      const sentAt = Date.now();
      return primeLobby(
        queryClient,
        unwrap(
          await fetchClient.POST("/games/lobbies/{id}/drawing", {
            ...lobbyPath(lobbyId),
            body: { strokes },
          }),
        ),
        sentAt,
      );
    },
  });
}

export function useSubmitBluff(lobbyId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const sentAt = Date.now();
      return primeLobby(
        queryClient,
        unwrap(
          await fetchClient.POST("/games/lobbies/{id}/bluff", {
            ...lobbyPath(lobbyId),
            body: { text },
          }),
        ),
        sentAt,
      );
    },
  });
}

export function useSubmitVote(lobbyId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (answer: number) => {
      const sentAt = Date.now();
      return primeLobby(
        queryClient,
        unwrap(
          await fetchClient.POST("/games/lobbies/{id}/vote", {
            ...lobbyPath(lobbyId),
            body: { answer },
          }),
        ),
        sentAt,
      );
    },
  });
}

// How often to re-ask while a stage the server should have moved past is
// still showing (this device's clock can run a little ahead of it).
const STAGE_POLL_MS = 700;

function refetchLobby(queryClient: QueryClient, lobbyId: number) {
  void queryClient.invalidateQueries({ queryKey: gameLobbyQueryKey(lobbyId) });
}

// Stages end on the clock as often as on a submission, and only the latter
// sends an event — so the moment the countdown or the current stage's timer
// runs out, fetch what comes next (and keep asking until it arrives).
export function useStageAdvance(lobby: GameLobby, now: number): void {
  const queryClient = useQueryClient();
  const stage = lobby.drawing?.stage;
  const lastAsk = useRef(0);
  const dueAt = stage
    ? stage.endsAt
    : lobby.phase === "countdown"
      ? lobby.startsAt
      : null;
  const overdue = dueAt !== null && now >= dueAt;
  useEffect(() => {
    if (!overdue || now - lastAsk.current < STAGE_POLL_MS) return;
    lastAsk.current = now;
    refetchLobby(queryClient, lobby.id);
  }, [overdue, now, lobby.id, queryClient]);
}
