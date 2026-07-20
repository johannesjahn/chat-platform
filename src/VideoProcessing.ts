// Uploaded videos are downscaled and transcoded during the upload path
// (`AttachmentsHandler.ts`) instead of storing/serving originals
// unprocessed — mirrors `ImageProcessing.ts` (issue #248) for video
// attachments (issue #251).

// Longest edge a stored video is allowed to keep. `AttachmentPreview.tsx`
// never renders an attachment taller than `max-h-72` (a few hundred px), so
// 720p is already far more resolution than the UI displays — same
// reasoning as `MAX_IMAGE_DIMENSION_PX` for images.
const MAX_VIDEO_DIMENSION_PX = 1280;

// libvpx-vp9's constrained-quality mode: encode at CRF 32 (visually
// transparent for typical phone-camera footage at 720p) but never exceed
// this bitrate, so an unusually complex/high-motion clip can't blow past a
// reasonable stored size the way an unbounded CRF encode could.
const VIDEO_CRF = 32;
const VIDEO_MAX_BITRATE = "1M";
const AUDIO_BITRATE = "96k";

// Transcoded to WebM (VP9 + Opus) regardless of input container/codec, the
// same way image uploads are always transcoded to WebP regardless of input
// format (see ImageProcessing.ts) — so already-WebM uploads are re-encoded
// at the capped resolution/bitrate rather than passed through untouched.
const OUTPUT_CONTENT_TYPE = "video/webm";

export type ProcessedVideo = {
  readonly data: Uint8Array;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
};

type FfprobeStream = { readonly width?: number; readonly height?: number };

// Decodes the video at `inputPath`, scales it down to the capped resolution,
// and transcodes it to WebM. Throws if ffmpeg can't decode `inputPath` as a
// video, regardless of the claimed content type — the caller
// (AttachmentsHandler.ts) maps that to a 415.
export const processVideo = async (
  inputPath: string,
): Promise<ProcessedVideo> => {
  const outputPath = `${inputPath}-${crypto.randomUUID()}.webm`;
  try {
    // `force_original_aspect_ratio=decrease` fits the source into a
    // min(iw,MAX) x min(ih,MAX) box while preserving aspect ratio — for a
    // source already at or below the cap on both edges that box is just the
    // source size, so it never upscales, mirroring `fit: inside,
    // withoutEnlargement: true` in ImageProcessing.ts. `force_divisible_by=2`
    // rounds the result to even dimensions, required by yuv420p's chroma
    // subsampling.
    await Bun.$`ffmpeg -y -i ${inputPath} -vf ${`scale=w='min(iw,${MAX_VIDEO_DIMENSION_PX})':h='min(ih,${MAX_VIDEO_DIMENSION_PX})':force_original_aspect_ratio=decrease:force_divisible_by=2`} -c:v libvpx-vp9 -crf ${VIDEO_CRF} -b:v ${VIDEO_MAX_BITRATE} -c:a libopus -b:a ${AUDIO_BITRATE} ${outputPath}`.quiet();

    const probe =
      await Bun.$`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json ${outputPath}`
        .quiet()
        .text();
    const { streams } = JSON.parse(probe) as {
      readonly streams: ReadonlyArray<FfprobeStream>;
    };
    const data = await Bun.file(outputPath).bytes();

    return {
      data,
      contentType: OUTPUT_CONTENT_TYPE,
      width: streams[0]?.width ?? 0,
      height: streams[0]?.height ?? 0,
    };
  } finally {
    await Bun.$`rm -f ${outputPath}`.quiet().nothrow();
  }
};
