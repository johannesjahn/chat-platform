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

// Formats that get scaled down and transcoded to WebP (see below). GIF is
// included: sharp/libvips reads every frame when given `{ animated: true }`
// and preserves them through `.resize()`/`.webp()`, so animated GIFs come
// out as animated WebP rather than being passed through as original bytes
// (issue #257) — passthrough meant anything smuggled into GIF trailer bytes
// or comment/application extension blocks rode along unmodified into what
// got served to other users.
const RESCALABLE_IMAGE_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
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
  // `animated: true` reads every frame of a multi-frame GIF (equivalent to
  // `pages: -1`) instead of just the first; it's a no-op for already
  // single-frame formats. `.resize()`/`.webp()` then apply per-frame and
  // re-encode the whole animation, rather than only ever touching frame 0.
  const { data, info } = await sharp(input, {
    animated: contentType === "image/gif",
  })
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION_PX,
      height: MAX_IMAGE_DIMENSION_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp()
    .toBuffer({ resolveWithObject: true });

  // For animated output, `info.height` is the total stacked-frame canvas
  // height (`pageHeight` * frame count) — `pageHeight` is the actual
  // per-frame height callers want for display sizing.
  return {
    data,
    contentType: OUTPUT_CONTENT_TYPE,
    width: info.width,
    height: info.pageHeight ?? info.height,
    blurhash,
  };
};
