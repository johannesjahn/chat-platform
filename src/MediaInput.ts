// The input side of every ffmpeg/ffprobe call in the upload pipeline
// (VideoProcessing.ts, AudioProcessing.ts) — issue #732. An upload's claimed
// content type only picks the pipeline; ffmpeg detects the real format from
// the file's contents, and its file-opening demuxers (`hls`, `dash`, `concat`,
// `imf`, ...) can be steered into reading other files or URLs. So each call
// names what it may open instead of relying on the blanket defaults.
//
// This isn't only theoretical: the upload's temp file keeps the client's file
// name (Effect's multipart persistence), so a `.m3u8` name is enough to get
// past the HLS demuxer's own check for a playlist-like extension. On `pipe:0`
// that check always fails, but `concat` is still detected there.

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

// Both of these are the whole input, whitelists and `-i` together, because the
// options only apply to the input that follows them. `file` because
// processVideo works from the upload's temp file on disk; it also reads back
// the WebM it wrote next to it, which `matroska` covers.
export const videoFileInput = (path: string): ReadonlyArray<string> => [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  VIDEO_DEMUXERS,
  "-i",
  path,
];

// `pipe` because the audio pipeline feeds its bytes over stdin.
export const AUDIO_PIPE_INPUT: ReadonlyArray<string> = [
  "-protocol_whitelist",
  "pipe",
  "-format_whitelist",
  AUDIO_DEMUXERS,
  "-i",
  "pipe:0",
];
