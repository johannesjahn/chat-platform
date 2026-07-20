// Cheap magic-byte/container-signature check for video/audio attachment
// uploads, run against a small byte prefix before the heavier ffmpeg-based
// processing (VideoProcessing.ts/AudioProcessing.ts) gets a chance to spawn
// a subprocess on it — see issue #254. Images don't need this: every
// `image/*` upload is already fully decoded through `sharp`
// (ImageProcessing.ts), which is a strictly stronger check. PDF is out of
// scope (uploads are disabled entirely — see ALLOWED_ATTACHMENT_MIME_TYPES
// in Api.ts).
//
// This is a floor, not a replacement for what ffmpeg's actual decode
// attempt already verifies: it only proves the upload *starts* the way its
// claimed container must start, so real (if oddly labeled) media still
// reaches ffmpeg for the real check, while obviously non-media bytes
// (scripts, executables, garbage) get rejected without spending a
// subprocess on them.

const startsWithBytes = (
  bytes: Uint8Array,
  offset: number,
  expected: ReadonlyArray<number>,
): boolean => expected.every((byte, i) => bytes[offset + i] === byte);

const asciiCodes = (s: string): ReadonlyArray<number> =>
  Array.from(s, (c) => c.charCodeAt(0));

const isMp4 = (bytes: Uint8Array): boolean =>
  startsWithBytes(bytes, 4, asciiCodes("ftyp"));

const isWebm = (bytes: Uint8Array): boolean =>
  startsWithBytes(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3]);

const isMpegAudio = (bytes: Uint8Array): boolean =>
  startsWithBytes(bytes, 0, asciiCodes("ID3")) ||
  (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);

const isOgg = (bytes: Uint8Array): boolean =>
  startsWithBytes(bytes, 0, asciiCodes("OggS"));

const isWav = (bytes: Uint8Array): boolean =>
  startsWithBytes(bytes, 0, asciiCodes("RIFF")) &&
  startsWithBytes(bytes, 8, asciiCodes("WAVE"));

// Keyed on the exact ALLOWED_ATTACHMENT_MIME_TYPES entries this applies to
// (see Api.ts).
const SIGNATURE_CHECKS: Readonly<
  Record<string, (bytes: Uint8Array) => boolean>
> = {
  "video/mp4": isMp4,
  "video/webm": isWebm,
  "audio/mpeg": isMpegAudio,
  "audio/ogg": isOgg,
  "audio/wav": isWav,
};

// How many leading bytes callers need to read to cover every signature
// above (the WAV check reaches furthest: "WAVE" at offset 8-11).
export const ATTACHMENT_SIGNATURE_PREFIX_BYTES = 16;

// Returns false only for a content type this module has a signature for
// where `prefix` doesn't match it. Content types with no defined signature
// pass through unchecked.
export const hasValidAttachmentSignature = (
  contentType: string,
  prefix: Uint8Array,
): boolean => {
  const check = SIGNATURE_CHECKS[contentType];
  return check ? check(prefix) : true;
};
