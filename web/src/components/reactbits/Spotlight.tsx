import { cn } from "@/lib/utils";

export type SpotlightProps = {
  className?: string;
  color?: string;
  size?: number;
};

// Pointer-tracking highlight adapted from reactbits' Spotlight Card. This is
// just the glow overlay — drop it as the first child of a `group relative
// overflow-hidden` container whose `onMouseMove` updates the `--spot-x` /
// `--spot-y` custom properties it reads, e.g.:
//
//   <Card
//     className="group relative overflow-hidden"
//     onMouseMove={(e) => {
//       const rect = e.currentTarget.getBoundingClientRect();
//       e.currentTarget.style.setProperty("--spot-x", `${e.clientX - rect.left}px`);
//       e.currentTarget.style.setProperty("--spot-y", `${e.clientY - rect.top}px`);
//     }}
//   >
//     <Spotlight />
//     ...
//   </Card>
export function Spotlight({
  className,
  color = "oklch(0.62 0.19 277 / 0.35)",
  size = 420,
}: SpotlightProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-500 group-hover:opacity-100",
        className,
      )}
      style={{
        background: `radial-gradient(${size}px circle at var(--spot-x, 50%) var(--spot-y, 0%), ${color}, transparent 70%)`,
      }}
    />
  );
}
