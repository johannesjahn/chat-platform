// Uploaded audio attachments are transcoded to a single small,
// broadly-compatible output format during the upload path
// (`AttachmentsHandler.ts`), mirroring the pattern `ImageProcessing.ts` uses
// for images — see issue #252. Shells out to the `ffmpeg`/`ffprobe`
// binaries (installed in the Docker image — see `Dockerfile`) rather than a
// JS/wasm decoder: unlike images there's no equivalent of `sharp` covering
// the handful of input codecs `ALLOWED_ATTACHMENT_MIME_TYPES` allows
// (mp3/ogg/wav) plus Opus encoding in one native dependency.

// Ogg/Opus: small, broadly supported by browsers for playback, and a single
// output format regardless of input (mp3/ogg/wav) — same rationale as
// re-encoding every rescaled image to WebP rather than preserving format.
const OUTPUT_CONTENT_TYPE = "audio/ogg";

// A fixed ceiling well above what voice/music needs to sound fine played
// back in chat, similar to how `MAX_IMAGE_DIMENSION_PX` caps images — this
// is what actually bounds storage/bandwidth regardless of the source's
// bitrate.
const OPUS_BITRATE = "64k";

// Opus's native internal rate; ffmpeg resamples down to this if the source
// is higher (e.g. 48kHz+ WAV) and leaves it alone if already lower — never
// upsampled.
const OUTPUT_SAMPLE_RATE_HZ = 48000;

// Mono/stereo is enough for chat/post playback (issue #252) — anything
// wider (5.1, etc.) gets downmixed rather than rejected, since ffmpeg does
// this losslessly-enough for voice/music without extra user friction.
const MAX_OUTPUT_CHANNELS = 2;

// How many amplitude buckets a stored waveform is reduced to. The player
// draws fewer bars than this on a narrow pill and averages neighbours down
// to fit, so this is "enough detail to resample from" rather than a bar
// count: 64 small integers cost ~250 bytes of JSON per attachment, which
// rides along in every message/post payload carrying an audio file.
const WAVEFORM_BUCKET_COUNT = 64;

// The waveform pass decodes the *stored* Opus back to raw mono PCM at this
// rate — deliberately far below OUTPUT_SAMPLE_RATE_HZ. Bucket averages over
// a whole clip don't get more accurate with more samples per bucket, and
// 8kHz keeps a 5-minute voice message's decode buffer under 5MB.
const ANALYSIS_SAMPLE_RATE_HZ = 8000;

// Floor (of 100) every bar is drawn at, so a silent stretch reads as a thin
// line through the middle of the pill rather than a gap in the row.
const WAVEFORM_MIN_LEVEL = 4;

// Bucket levels are normalized against the loudest bucket, then bent by
// this exponent before being stored. A raw RMS curve of ordinary speech
// spends most of its range near the bottom (quiet consonants, pauses) with
// a handful of spikes; < 1 lifts that body up without touching the peak,
// which is what makes the drawn row read as the clip's shape instead of a
// flat line with a few spikes in it.
const WAVEFORM_CURVE_EXPONENT = 0.65;

const bytesFromStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

// Reads the source's channel count via ffprobe rather than assuming one —
// also doubles as upload validation: ffprobe exits non-zero for anything
// that isn't decodable audio, regardless of the claimed content type.
const probeChannelCount = async (input: Uint8Array): Promise<number> => {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=channels",
      "-of",
      "csv=p=0",
      "-i",
      "pipe:0",
    ],
    { stdin: input, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await bytesFromStream(proc.stdout);
  const exitCode = await proc.exited;
  const channels = Number.parseInt(new TextDecoder().decode(stdout).trim(), 10);
  if (exitCode !== 0 || !Number.isFinite(channels) || channels < 1) {
    throw new Error("Uploaded file is not a valid audio stream");
  }
  return channels;
};

// Reduces raw mono PCM to `bucketCount` levels in 0..100, one per equal
// slice of the clip. Exported for its own tests — it's the half of the
// waveform pass that has nothing to do with ffmpeg.
//
// Each bucket is the RMS (not the peak) of its slice: a peak curve of
// speech is a row of near-full-height spikes, because a single loud sample
// anywhere in a ~50ms slice sets the whole bar, while RMS tracks how loud
// that stretch actually *sounds*. That's the difference between bars that
// look like noise and bars that look like the clip.
export const waveformFromPcm = (
  samples: Int16Array,
  bucketCount: number = WAVEFORM_BUCKET_COUNT,
): number[] => {
  const levels = new Array<number>(bucketCount).fill(0);
  if (samples.length === 0) return levels.fill(WAVEFORM_MIN_LEVEL);

  let loudest = 0;
  const rms = new Array<number>(bucketCount).fill(0);
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = Math.floor((bucket * samples.length) / bucketCount);
    const end = Math.floor(((bucket + 1) * samples.length) / bucketCount);
    // A clip shorter than one sample per bucket (or a bucket that rounds to
    // an empty slice) still gets a level, by reading the single sample its
    // slice starts on rather than dividing by zero.
    let sum = 0;
    let count = 0;
    for (let i = start; i < Math.max(end, start + 1); i++) {
      const sample = samples[Math.min(i, samples.length - 1)]!;
      sum += sample * sample;
      count++;
    }
    const level = Math.sqrt(sum / count);
    rms[bucket] = level;
    if (level > loudest) loudest = level;
  }

  // Normalizing against the clip's own loudest bucket (rather than the
  // format's full scale) is what makes a quietly-recorded voice message
  // draw the same shape as a loud one instead of a flat line.
  if (loudest === 0) return levels.fill(WAVEFORM_MIN_LEVEL);
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const scaled = Math.pow(rms[bucket]! / loudest, WAVEFORM_CURVE_EXPONENT);
    levels[bucket] = Math.max(
      WAVEFORM_MIN_LEVEL,
      Math.min(100, Math.round(scaled * 100)),
    );
  }
  return levels;
};

export type AudioWaveform = {
  readonly waveform: ReadonlyArray<number>;
  readonly durationMs: number;
};

// Decodes `ogg` (the transcoded output, not the original upload — so the
// drawn shape and the reported length describe exactly the bytes the player
// will fetch) to raw mono PCM and reduces it to a stored waveform.
//
// Duration comes out of the same pass for free: at a known mono sample rate
// the decoded sample count *is* the length, which saves a second ffprobe
// and, more usefully, gives the player a duration up front — Ogg/Opus
// served over a presigned URL doesn't always hand the browser a usable
// `duration` on `loadedmetadata`.
export const analyzeAudio = async (ogg: Uint8Array): Promise<AudioWaveform> => {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(ANALYSIS_SAMPLE_RATE_HZ),
      "-f",
      "s16le",
      "pipe:1",
    ],
    { stdin: ogg, stdout: "pipe", stderr: "pipe" },
  );

  const [pcm, exitCode] = await Promise.all([
    bytesFromStream(proc.stdout),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error("Transcoded audio could not be analyzed");
  }

  // `bytesFromStream` always hands back a view starting at offset 0 of its
  // own buffer, so this reinterprets the bytes in place rather than copying
  // them. s16le matches the native byte order of every platform this runs
  // on (x86-64/arm64, both little-endian).
  const samples = new Int16Array(pcm.buffer, 0, pcm.byteLength >> 1);
  return {
    waveform: waveformFromPcm(samples),
    durationMs: Math.round((samples.length / ANALYSIS_SAMPLE_RATE_HZ) * 1000),
  };
};

export type ProcessedAudio = {
  readonly data: Uint8Array;
  readonly contentType: string;
  // A 0..100 amplitude bar per equal slice of the clip, plus its length —
  // stored on the attachment row so every reader draws the real shape of
  // the audio instead of a placeholder (see web/src/components/AudioPlayer).
  // Null if the waveform pass failed on audio that otherwise transcoded
  // fine; see processAudio below.
  readonly waveform: ReadonlyArray<number> | null;
  readonly durationMs: number | null;
};

// Transcodes `input` to Ogg/Opus at a fixed bitrate/sample-rate ceiling,
// downmixing to at most stereo. Throws if `input` isn't decodable audio,
// regardless of the claimed content type — the caller
// (`AttachmentsHandler.ts`) maps that to a 415, same as `processImage`.
export const processAudio = async (
  input: Uint8Array,
): Promise<ProcessedAudio> => {
  const sourceChannels = await probeChannelCount(input);
  const targetChannels = Math.min(sourceChannels, MAX_OUTPUT_CHANNELS);

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      // Drops any embedded video/album-art stream (common in mp3 files) —
      // the Ogg muxer below only takes an audio stream — and strips
      // metadata (ID3 tags, etc.) rather than carrying it through.
      "-vn",
      "-map_metadata",
      "-1",
      "-ac",
      String(targetChannels),
      "-ar",
      String(OUTPUT_SAMPLE_RATE_HZ),
      "-c:a",
      "libopus",
      "-b:a",
      OPUS_BITRATE,
      "-f",
      "ogg",
      "pipe:1",
    ],
    { stdin: input, stdout: "pipe", stderr: "pipe" },
  );

  const [data, exitCode] = await Promise.all([
    bytesFromStream(proc.stdout),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error("Uploaded file could not be transcoded as audio");
  }

  // The clip is already transcoded and playable at this point, and the
  // waveform is decoration on top of it — so a failure here degrades to
  // "no stored waveform" (the player falls back to decoding the clip in
  // the browser) rather than 415-ing an upload that was perfectly valid.
  const analysis = await analyzeAudio(data).catch(() => null);
  return {
    data,
    contentType: OUTPUT_CONTENT_TYPE,
    waveform: analysis?.waveform ?? null,
    durationMs: analysis?.durationMs ?? null,
  };
};
