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

export type ProcessedAudio = {
  readonly data: Uint8Array;
  readonly contentType: string;
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

  return { data, contentType: OUTPUT_CONTENT_TYPE };
};
