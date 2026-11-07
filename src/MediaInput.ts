// The only place the upload pipeline (VideoProcessing.ts, AudioProcessing.ts)
// starts ffmpeg or ffprobe — issues #732, #734. An upload's claimed content type
// only picks the pipeline; ffmpeg detects the real format from the file's
// contents, and its file-opening demuxers (`hls`, `dash`, `concat`, `imf`, ...)
// can be steered into reading other files or URLs, and a decoder bug is reachable
// from any stream a container can carry. So each call names the protocol,
// demuxers and decoders it may use instead of relying on the blanket defaults.
// MediaInput.test.ts fails on a call anywhere else in `src/`.
//
// A file's name can steer detection too (a `.m3u8` name gets past the HLS
// demuxer's own check for a playlist-like extension), and the upload's temp file
// keeps the client's name, so processVideo hands ffmpeg a copy named by the
// server. Audio has no name at all: it goes over `pipe:0`, where that check
// always fails, though `concat` is still detected there.

// Demuxer names as `ffmpeg -demuxers` lists them, checked against the 7.1.5 the
// Dockerfile pins. ffmpeg matches any one of the comma-separated names a
// demuxer registers under, so `mov` stands for `mov,mp4,m4a,3gp,3g2,mj2` and
// `matroska` for `matroska,webm` — these can't be split any finer (a `.mov`
// or `.mkv` passes as well as the MP4/WebM we asked for).
//
// These lists mirror the video/audio entries of
// `ALLOWED_ATTACHMENT_MIME_TYPES` (Api.ts): adding a MIME type there means
// checking its demuxer is listed here.
//
// video/mp4 → mov, video/webm → matroska
const VIDEO_DEMUXERS = "mov,matroska";
// audio/mp4 (Safari voice messages) → mov, audio/webm (Chrome/Firefox voice
// messages) → matroska, audio/mpeg → mp3, audio/ogg → ogg, audio/wav → wav.
// The Ogg/Opus that processAudio produces reads back through `ogg` too.
const AUDIO_DEMUXERS = "mov,matroska,mp3,ogg,wav";

// Decoder names as `ffmpeg -decoders` lists them: unlike demuxers these are the
// decoders' own names, not the codecs', and ffmpeg doesn't fall back to another
// decoder of the same codec, so each entry is the one 7.1.5 picks by default
// (`libdav1d` for AV1, whose native `av1` decoder needs hardware; `mp3float` for
// MP3). Off the list: anything else a container can carry, such as FLAC, AC-3,
// MPEG-4 Part 2 or subtitles, and the images in album art.
//
// ffmpeg only fails on a stream it was going to use, so an MP3 with album art
// still transcodes as long as the art isn't selected, which is why processAudio
// passes `-vn` and processVideo `-sn -dn`. ffprobe fails on any off-list stream
// in the file, even with `-select_streams`, so it can't be pointed at an upload
// that might carry one: only processVideo's own output is probed.
//
// Opus also covers the Ogg/Opus processAudio produces, VP9 and Opus the WebM
// processVideo produces. PCM is every sample format WAV and QuickTime commonly
// use, in both byte orders.
const AUDIO_DECODERS = [
  "aac",
  "opus",
  "vorbis",
  "mp3float",
  "pcm_u8",
  "pcm_s16le",
  "pcm_s16be",
  "pcm_s24le",
  "pcm_s24be",
  "pcm_s32le",
  "pcm_s32be",
  "pcm_f32le",
  "pcm_f32be",
].join(",");
const VIDEO_DECODERS = `h264,hevc,vp8,vp9,libdav1d,${AUDIO_DECODERS}`;

// Both of these are the whole input, whitelists and `-i` together, because the
// options only apply to the input that follows them. `file` because
// processVideo works from a temp file on disk; it also reads back the WebM it
// wrote next to it, which `matroska` covers.
export const videoFileInput = (path: string): ReadonlyArray<string> => [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  VIDEO_DEMUXERS,
  "-codec_whitelist",
  VIDEO_DECODERS,
  "-i",
  path,
];

// `pipe` because the audio pipeline feeds its bytes over stdin.
export const AUDIO_PIPE_INPUT: ReadonlyArray<string> = [
  "-protocol_whitelist",
  "pipe",
  "-format_whitelist",
  AUDIO_DEMUXERS,
  "-codec_whitelist",
  AUDIO_DECODERS,
  "-i",
  "pipe:0",
];

// What a call reads: a video file on disk (whose name must be the server's), or
// audio bytes sent over stdin.
export type MediaSource =
  { readonly videoPath: string } | { readonly audio: Uint8Array };

const run = async (
  command: ReadonlyArray<string>,
  source: MediaSource,
): Promise<Uint8Array> => {
  const proc = Bun.spawn([...command], {
    stdin: "audio" in source ? source.audio : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Both drained at once: a full pipe would otherwise stall the process.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited with ${exitCode}: ${stderr}`);
  }
  return stdout;
};

const restrictedInput = (source: MediaSource): ReadonlyArray<string> =>
  "audio" in source ? AUDIO_PIPE_INPUT : videoFileInput(source.videoPath);

// Runs ffmpeg on `source`, with `outputArgs` following the input, and resolves
// to its stdout. Rejects with ffmpeg's error output if it exits non-zero.
export const runFfmpeg = (
  source: MediaSource,
  outputArgs: ReadonlyArray<string>,
): Promise<Uint8Array> =>
  run(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...restrictedInput(source),
      ...outputArgs,
    ],
    source,
  );

// The same for ffprobe, resolving to its stdout as text. Mind the note on
// ffprobe above the decoder lists.
export const runFfprobe = async (
  source: MediaSource,
  args: ReadonlyArray<string>,
): Promise<string> =>
  new TextDecoder().decode(
    await run(
      ["ffprobe", "-v", "error", ...args, ...restrictedInput(source)],
      source,
    ),
  );
