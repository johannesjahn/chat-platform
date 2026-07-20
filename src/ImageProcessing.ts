import { encode as encodeBlurHash } from "blurhash";
import sharp from "sharp";

// Uploaded images are scaled down and a BlurHash placeholder is generated
// during the upload path (`AttachmentsHandler.ts`) instead of storing/serving
// originals unprocessed — see issue #248.

// Longest edge a stored image is allowed to keep. Uploads up to
// `MAX_ATTACHMENT_SIZE_BYTES` (25MB, Api.ts) were previously stored and
// served at full original resolution even though the UI never renders them
// larger than a few hundred px (AttachmentPreview.tsx caps at `max-h-72`).
const MAX_IMAGE_DIMENSION_PX = 2048;

// BlurHash is encoded from a tiny decode, not the full-resolution image —
// the placeholder is deliberately blurry, and encode cost is O(pixels).
const BLURHASH_SAMPLE_PX = 32;
const BLURHASH_COMPONENTS_X = 4;
const BLURHASH_COMPONENTS_Y = 3;

// Formats that get scaled down and transcoded to WebP (see below). Animated
// GIF is deliberately excluded: sharp represents an animated image's frames
// internally as one tall vertically-stacked strip, and re-encoding through
// the same single-frame resize path used here risks mangling frame
// boundaries or silently flattening the animation to its first frame. GIF
// uploads keep their original bytes; they still get real dimensions and a
// blurhash below, just derived from the first frame rather than driving a
// re-encode.
const RESCALABLE_IMAGE_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Rescaled images are always transcoded to WebP rather than kept in their
// original format: it compresses meaningfully better than JPEG at
// equivalent visual quality, *and* — unlike JPEG — supports alpha
// transparency, so it strictly dominates both JPEG and PNG as a stored
// format regardless of what was uploaded. Preserving the input format
// would leave PNG photo uploads (common from screenshots) at full lossless
// size even after scaling, defeating the point of re-encoding at all.
const OUTPUT_CONTENT_TYPE = "image/webp";

export type ProcessedImage = {
  readonly data: Uint8Array;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly blurhash: string;
};

const blurhashFromFirstFrame = async (input: Uint8Array): Promise<string> => {
  const { data, info } = await sharp(input, { page: 0 })
    .rotate()
    .resize(BLURHASH_SAMPLE_PX, BLURHASH_SAMPLE_PX, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return encodeBlurHash(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
    BLURHASH_COMPONENTS_X,
    BLURHASH_COMPONENTS_Y,
  );
};

// Decodes `input`, scales it down (rescalable formats only — see above),
// re-encodes it, and generates a BlurHash placeholder. Throws if `input`
// isn't a decodable image, regardless of the claimed content type — the
// caller (AttachmentsHandler.ts) maps that to a 415.
export const processImage = async (
  input: Uint8Array,
  contentType: string,
): Promise<ProcessedImage> => {
  const blurhash = await blurhashFromFirstFrame(input);

  if (!RESCALABLE_IMAGE_MIME_TYPES.has(contentType)) {
    const meta = await sharp(input, { page: 0 }).metadata();
    return {
      data: input,
      contentType,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      blurhash,
    };
  }

  // Deliberately no `.withMetadata()` call here: sharp's default behavior
  // strips all EXIF/GPS/IPTC/XMP metadata on re-encode, and that's relied
  // upon as a privacy control — stored/served images shouldn't leak where
  // or on what device they were taken. Do not add `.withMetadata()` (e.g.
  // to preserve color profile data) without deliberately re-adding
  // EXIF/GPS stripping first; see the regression test in
  // ImageProcessing.test.ts and issue #258.
  const { data, info } = await sharp(input)
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION_PX,
      height: MAX_IMAGE_DIMENSION_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp()
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    contentType: OUTPUT_CONTENT_TYPE,
    width: info.width,
    height: info.height,
    blurhash,
  };
};
