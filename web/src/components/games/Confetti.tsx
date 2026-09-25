import { useState, type CSSProperties } from "react";

const COLORS = [
  "var(--game-from)",
  "var(--game-to)",
  "var(--game-gold)",
  "oklch(0.8 0.18 145)",
  "oklch(0.75 0.2 20)",
  "white",
];

// Every flake gets its own drift, spin, delay and fall time so the burst
// never looks tiled. Rolled once per mount (see `useState` below), not per
// render.
function makeFlakes(pieces: number) {
  return Array.from({ length: pieces }, (_, i) => ({
    left: Math.random() * 100,
    width: 6 + Math.random() * 6,
    height: 8 + Math.random() * 10,
    color: COLORS[i % COLORS.length],
    round: Math.random() < 0.3,
    style: {
      "--confetti-drift": `${(Math.random() - 0.5) * 240}px`,
      "--confetti-spin": `${(Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 900)}deg`,
      "--confetti-delay": `${Math.random() * 0.6}s`,
      "--confetti-duration": `${2.2 + Math.random() * 1.8}s`,
    } as CSSProperties,
  }));
}

// A one-shot burst of CSS confetti over the whole viewport — for a win.
// Hidden entirely under reduced motion (see styles.css); never intercepts
// the pointer. Re-key it to fire again.
export function Confetti({ pieces = 90 }: { pieces?: number }) {
  const [flakes] = useState(() => makeFlakes(pieces));
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
    >
      {flakes.map((flake, i) => (
        <span
          key={i}
          className="animate-confetti-fall absolute top-0"
          style={{
            ...flake.style,
            left: `${flake.left}%`,
            width: flake.width,
            height: flake.round ? flake.width : flake.height,
            borderRadius: flake.round ? "9999px" : "2px",
            background: flake.color,
          }}
        />
      ))}
    </div>
  );
}
