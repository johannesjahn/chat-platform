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

// Formats that get scaled down and re-encoded. Animated GIF is deliberately
// excluded: sharp represents an animated image's frames internally as one
// tall vertically-stacked strip, and re-encoding through the same
// single-frame resize path used here risks mangling frame boundaries or
// silently flattening the animation to its first frame. GIF uploads keep
// their original bytes; they still get real dimensions and a blurhash below,
// just derived from the first frame rather than driving a re-encode.
const RESCALABLE_IMAGE_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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

  const { data, info } = await sharp(input)
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION_PX,
      height: MAX_IMAGE_DIMENSION_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    contentType: `image/${info.format}`,
    width: info.width,
    height: info.height,
    blurhash,
  };
};
