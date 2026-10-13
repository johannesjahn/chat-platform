import { availableParallelism } from "node:os";
import { Effect, Semaphore } from "effect";

// Media processing (sharp/libvips for images and avatars, an ffmpeg
// subprocess for video and audio) is CPU- and memory-heavy and runs inline in
// the upload request. The per-user upload rate limits only bound one
// account's velocity — nothing bounded how many transcodes the *process* ran
// at once, so a flood spread across accounts spawned one ffmpeg/libvips
// pipeline per request and could saturate the instance (issue #325). Every
// processing step goes through one process-wide semaphore instead, so excess
// uploads queue rather than piling on in parallel.
//
// Sized to the core count by default. `availableParallelism()` reports the
// host's cores, not a container's CPU quota, so set
// `MEDIA_PROCESSING_CONCURRENCY` when running under a tighter limit (e.g. a
// Kubernetes CPU limit).
export const mediaProcessingConcurrency = (
  raw: string | undefined = process.env.MEDIA_PROCESSING_CONCURRENCY,
): number => {
  const configured = Number(raw);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : Math.max(1, availableParallelism());
};

// Only the wait for a permit is interruptible: a request whose client went
// away leaves the queue, but once processing has started it runs to the end
// while holding its permit. sharp/ffmpeg can't be cancelled mid-flight, so
// interrupting there would release the permit while the work carried on
// uncounted — exactly the unbounded parallelism this exists to prevent.
export const makeMediaProcessingLimit = (permits: number) => {
  const semaphore = Semaphore.makeUnsafe(permits);
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Semaphore.withPermit(semaphore, Effect.uninterruptible(effect));
};

// Wrap the whole step — reading the upload into memory included — so the cap
// bounds memory held by in-flight inputs as well as CPU.
export const withMediaProcessingPermit = makeMediaProcessingLimit(
  mediaProcessingConcurrency(),
);
