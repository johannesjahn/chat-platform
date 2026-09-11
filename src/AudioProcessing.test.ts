import { expect, test } from "bun:test";
import { waveformFromPcm } from "./AudioProcessing.ts";

// The ffmpeg-driven half of the waveform pass (decoding the stored Opus) is
// covered end to end by the upload tests in attachments.test.ts; what's
// worth testing on its own is the reduction from raw samples to the levels
// the player draws, since that's what decides whether the bars describe the
// clip or just look busy.

const BUCKETS = 8;

// `length` samples of a full-scale square wave at `amplitude` (0..1), so a
// slice's RMS is exactly `amplitude * 32767` and expectations can be stated
// in absolute terms rather than "roughly".
const constantAmplitude = (length: number, amplitude: number): Int16Array => {
  const samples = new Int16Array(length);
  const value = Math.round(amplitude * 32767);
  for (let i = 0; i < length; i++) samples[i] = i % 2 === 0 ? value : -value;
  return samples;
};

test("waveformFromPcm returns one level per bucket, all within 0..100", () => {
  const samples = constantAmplitude(8000, 0.5);
  const levels = waveformFromPcm(samples, BUCKETS);
  expect(levels).toHaveLength(BUCKETS);
  for (const level of levels) {
    expect(level).toBeGreaterThanOrEqual(0);
    expect(level).toBeLessThanOrEqual(100);
  }
});

test("waveformFromPcm normalizes against the clip's own loudest stretch", () => {
  // A quiet recording and a loud one with the same shape should draw the
  // same bars — otherwise every voice message recorded at a sane input
  // level would render as a flat line near the floor.
  const quiet = waveformFromPcm(constantAmplitude(4000, 0.02), BUCKETS);
  const loud = waveformFromPcm(constantAmplitude(4000, 0.9), BUCKETS);
  expect(quiet).toEqual(loud);
  expect(loud.every((level) => level === 100)).toBe(true);
});

test("waveformFromPcm tracks where the clip is loud and where it isn't", () => {
  // Second half silent: the bars for it must sit at the floor while the
  // first half tops out, which is the whole point of storing real levels.
  const samples = constantAmplitude(8000, 0.8);
  samples.fill(0, 4000);
  const levels = waveformFromPcm(samples, BUCKETS);
  const [first, second] = [levels.slice(0, 4), levels.slice(4)];
  expect(first.every((level) => level === 100)).toBe(true);
  expect(second.every((level) => level < 10)).toBe(true);
});

test("waveformFromPcm draws a flat line for silence rather than nothing", () => {
  // A fully silent clip has no loudest bucket to normalize against; every
  // bar still gets the floor so the player renders a row, not a gap.
  const levels = waveformFromPcm(new Int16Array(4000), BUCKETS);
  expect(levels).toHaveLength(BUCKETS);
  expect(new Set(levels).size).toBe(1);
  expect(levels[0]).toBeGreaterThan(0);
  expect(levels[0]).toBeLessThan(20);
});

test("waveformFromPcm handles a clip with no samples at all", () => {
  const levels = waveformFromPcm(new Int16Array(0), BUCKETS);
  expect(levels).toHaveLength(BUCKETS);
  expect(levels.every((level) => level > 0)).toBe(true);
});

test("waveformFromPcm fills every bucket for a clip shorter than one sample per bar", () => {
  // 3 samples across 8 buckets — buckets whose slice rounds to empty read
  // the sample their slice starts on instead of dividing by zero (NaN would
  // reach the player as an unrenderable bar height).
  const levels = waveformFromPcm(constantAmplitude(3, 0.6), BUCKETS);
  expect(levels).toHaveLength(BUCKETS);
  for (const level of levels) expect(Number.isFinite(level)).toBe(true);
  expect(levels.every((level) => level === 100)).toBe(true);
});

test("waveformFromPcm lifts quiet detail clear of the floor", () => {
  // A stretch at a tenth of the clip's peak is audible, so it must be
  // visibly taller than silence — a straight linear mapping would draw it
  // at 10 of 100 and lose it against the floor.
  const samples = constantAmplitude(8000, 1);
  const tenth = Math.round(0.1 * 32767);
  for (let i = 4000; i < 8000; i++) samples[i] = i % 2 === 0 ? tenth : -tenth;
  const levels = waveformFromPcm(samples, BUCKETS);
  const quietBars = levels.slice(4);
  expect(quietBars.every((level) => level > 15)).toBe(true);
  expect(quietBars.every((level) => level < 50)).toBe(true);
});
