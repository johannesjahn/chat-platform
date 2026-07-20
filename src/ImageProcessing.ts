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

// Minimum source dimensions an avatar upload must clear *before* any
// cropping (issue #269) — rejects images too small to produce a decent
// `large` variant (see AVATAR_VARIANT_PX below) regardless of what square
// region within it ends up chosen.
export const MIN_AVATAR_SOURCE_PX = 256;

// Fixed output sizes an avatar is resized to (issue #269), replacing
// `AVATAR_SIZES`' old approach of serving one full-resolution image scaled
// down by CSS everywhere. Roughly 2x the largest CSS box each is displayed
// in (see `AVATAR_SIZES` in web/src/components/Avatar.tsx: sm/md both map to
// "small", lg to "medium", xl to "large") for a reasonably crisp look on
// high-DPI screens without storing/serving anything close to the original
// upload's resolution.
export const AVATAR_VARIANT_PX = {
  small: 96,
  medium: 192,
  large: 320,
} as const;

export type AvatarCropRegion = {
  readonly x: number;
  readonly y: number;
  readonly size: number;
};

export type ProcessedAvatar = {
  readonly small: Uint8Array;
  readonly medium: Uint8Array;
  readonly large: Uint8Array;
  readonly contentType: string;
};

// Crops `input` to the square region described by `crop` and resizes it into
// the 3 fixed AVATAR_VARIANT_PX sizes, re-encoded as WebP (see
// OUTPUT_CONTENT_TYPE's rationale above — same tradeoffs apply here).
// Throws (mapped by the caller — UsersHandler.ts — to a typed
// InvalidAvatarUpload error) if `input` isn't a decodable image, is smaller
// than MIN_AVATAR_SOURCE_PX in either dimension, or `crop` falls outside the
// image's actual bounds.
export const processAvatar = async (
  input: Uint8Array,
  crop: AvatarCropRegion,
): Promise<ProcessedAvatar> => {
  // Rotate once up front (EXIF-orientation-aware, like processImage above)
  // and materialize the result: sharp's `.metadata()` reports the raw file's
  // *pre*-rotation dimensions even with `.rotate()` queued ahead of it, but
  // `crop` is computed by the frontend against the image as the browser
  // displays it (i.e. already auto-rotated) — so the only reliable way to
  // validate/extract against matching dimensions is to actually apply the
  // rotation first.
  const { data: oriented, info } = await sharp(input)
    .rotate()
    .toBuffer({ resolveWithObject: true });

  if (info.width < MIN_AVATAR_SOURCE_PX || info.height < MIN_AVATAR_SOURCE_PX) {
    throw new Error(
      `Image must be at least ${MIN_AVATAR_SOURCE_PX}x${MIN_AVATAR_SOURCE_PX}px (got ${info.width}x${info.height})`,
    );
  }

  const { x, y, size } = crop;
  if (
    !Number.isFinite(size) ||
    size <= 0 ||
    x < 0 ||
    y < 0 ||
    x + size > info.width ||
    y + size > info.height
  ) {
    throw new Error("Crop region is outside the image bounds");
  }

  const cropped = sharp(oriented).extract({
    left: Math.round(x),
    top: Math.round(y),
    width: Math.round(size),
    height: Math.round(size),
  });

  // Deliberately no `.withMetadata()` — same EXIF/GPS-stripping privacy
  // rationale as processImage above, and the regression test in
  // ImageProcessing.test.ts covers this for avatars too.
  const [small, medium, large] = await Promise.all([
    cropped
      .clone()
      .resize(AVATAR_VARIANT_PX.small, AVATAR_VARIANT_PX.small)
      .webp()
      .toBuffer(),
    cropped
      .clone()
      .resize(AVATAR_VARIANT_PX.medium, AVATAR_VARIANT_PX.medium)
      .webp()
      .toBuffer(),
    cropped
      .clone()
      .resize(AVATAR_VARIANT_PX.large, AVATAR_VARIANT_PX.large)
      .webp()
      .toBuffer(),
  ]);

  return { small, medium, large, contentType: OUTPUT_CONTENT_TYPE };
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
