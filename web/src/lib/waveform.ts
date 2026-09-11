// Shaping for the bars AudioPlayer draws.
//
// The levels themselves normally arrive precomputed on the attachment
// (`waveform`/`durationMs`, measured from the transcoded clip at upload
// time — see `waveformFromPcm` in src/AudioProcessing.ts): the browser
// can't compute them without downloading and decoding the whole file, and
// a chat view can hold a dozen clips it will never play. This module only
// has to (a) fit whatever level count the server stored into the number of
// bars actually drawn, and (b) recover a waveform for a clip that predates
// the server-side pass, by decoding it in the browser after all.

// Bars drawn per player. Deliberately fewer than the levels the server
// stores, so the row stays legible in a narrow message bubble — the extra
// resolution is averaged down rather than dropped.
export const WAVEFORM_BAR_COUNT = 56;

// Mirrors WAVEFORM_MIN_LEVEL/WAVEFORM_CURVE_EXPONENT in
// src/AudioProcessing.ts — the browser fallback below has to shape its
// levels the same way the server does, or a clip's bars would change the
// first time someone played it.
const MIN_LEVEL = 4;
const CURVE_EXPONENT = 0.65;

// Averages (rather than samples) neighbouring levels when reducing, so a
// single loud bucket can't disappear between two drawn bars; a clip stored
// with fewer levels than bars repeats them instead.
export function resampleWaveform(
  levels: ReadonlyArray<number>,
  barCount: number = WAVEFORM_BAR_COUNT,
): number[] {
  if (levels.length === 0) return new Array<number>(barCount).fill(MIN_LEVEL);
  const bars: number[] = [];
  for (let bar = 0; bar < barCount; bar++) {
    const start = Math.floor((bar * levels.length) / barCount);
    const end = Math.max(
      Math.floor(((bar + 1) * levels.length) / barCount),
      start + 1,
    );
    let sum = 0;
    for (let i = start; i < end; i++)
      sum += levels[Math.min(i, levels.length - 1)]!;
    bars.push(sum / (end - start));
  }
  return bars;
}

// A flat row at the floor: what's drawn for a clip whose levels aren't
// known (yet). Reads as "a clip", not as a shape that turns out to be wrong
// once the real one arrives.
export function flatWaveform(barCount: number = WAVEFORM_BAR_COUNT): number[] {
  return new Array<number>(barCount).fill(MIN_LEVEL);
}

function levelsFromSamples(
  samples: Float32Array,
  bucketCount: number,
): number[] {
  const rms = new Array<number>(bucketCount).fill(0);
  let loudest = 0;
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = Math.floor((bucket * samples.length) / bucketCount);
    const end = Math.max(
      Math.floor(((bucket + 1) * samples.length) / bucketCount),
      start + 1,
    );
    let sum = 0;
    for (let i = start; i < end; i++) {
      const sample = samples[Math.min(i, samples.length - 1)] ?? 0;
      sum += sample * sample;
    }
    const level = Math.sqrt(sum / (end - start));
    rms[bucket] = level;
    if (level > loudest) loudest = level;
  }
  if (loudest === 0) return new Array<number>(bucketCount).fill(MIN_LEVEL);
  return rms.map((level) =>
    Math.max(
      MIN_LEVEL,
      Math.min(
        100,
        Math.round(Math.pow(level / loudest, CURVE_EXPONENT) * 100),
      ),
    ),
  );
}

// Fallback for audio uploaded before the server started storing a waveform:
// fetches the clip and decodes it in the browser. Callers should hold this
// until the clip is actually played — it downloads the file a second time
// (the <audio> element has its own copy), which is fine once for something
// the user asked to hear and wasteful for every clip on screen.
//
// Resolves to null rather than throwing for the many ways this can fail
// (offline, an expired presigned URL, a bucket that serves the clip to an
// <audio> element but not to a cross-origin `fetch`, a codec the Web Audio
// decoder won't take): the player just keeps its flat row.
export async function decodeWaveform(
  url: string,
  bucketCount: number = WAVEFORM_BAR_COUNT,
  signal?: AbortSignal,
): Promise<number[] | null> {
  if (typeof OfflineAudioContext === "undefined") return null;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const encoded = await response.arrayBuffer();
    if (signal?.aborted) return null;
    // An OfflineAudioContext decodes without touching (or waking) the
    // output device — decodeAudioData is all this needs.
    const context = new OfflineAudioContext(1, 1, 44100);
    const decoded = await context.decodeAudioData(encoded);
    if (signal?.aborted) return null;
    return levelsFromSamples(decoded.getChannelData(0), bucketCount);
  } catch {
    return null;
  }
}
