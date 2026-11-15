// `bun --preload ./scripts/loadtest/sim/loop-lag.ts src/main.ts` — logs this
// process's event-loop lag (how late a 10ms timer fires) every 5s to stderr,
// so a load test can tell "busy" from "blocked in long synchronous runs".
const samples: number[] = [];
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  samples.push(now - last - 10);
  last = now;
}, 10).unref();
setInterval(() => {
  const s = samples.splice(0).sort((a, b) => a - b);
  if (s.length === 0) return;
  const q = (p: number) =>
    s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(1);
  console.error(
    `[loop-lag] p50=${q(0.5)}ms p99=${q(0.99)}ms max=${s.at(-1)!.toFixed(1)}ms ticks=${s.length}/500`,
  );
}, 5000).unref();
