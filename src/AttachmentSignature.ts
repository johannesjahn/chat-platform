// Magic-byte/container-signature checks for attachment mime types that
// aren't otherwise decoded during upload (see AttachmentsHandler.ts). Images
// get a real decode via sharp (ImageProcessing.ts) and video gets a real
// decode via ffmpeg (VideoProcessing.ts) — both throw on non-matching bytes
// regardless of the claimed content type. Audio has no equivalent decode
// step, so without this check the client-supplied multipart Content-Type is
// the only gate, and it's trivially spoofed (issue #254). Video's signature
// check below is a cheap pre-filter on top of ffmpeg's decode: it lets
// obviously-wrong uploads fail fast with a 415 before paying for a
// transcode that would fail anyway.
//
// Only proves the file *starts* the way that container type must start —
// not a full decode, and not a defense against polyglot files valid under
// two formats at once. See issue #254 for the full threat model and why
// that's an accepted, documented limitation rather than a gap to close here.

const asciiAt = (bytes: Uint8Array, offset: number, ascii: string): boolean => {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
};

// MP3's "frame sync" is the first 11 bits of a frame header all set to 1
// (0xFF followed by the top 3 bits of the next byte) — present at the start
// of a raw (ID3-less) MPEG audio stream.
const hasMp3FrameSync = (bytes: Uint8Array): boolean =>
  bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;

const SIGNATURE_CHECKS: Record<string, (bytes: Uint8Array) => boolean> = {
  "video/mp4": (bytes) => asciiAt(bytes, 4, "ftyp"),
  "video/webm": (bytes) =>
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3,
  "audio/mpeg": (bytes) => asciiAt(bytes, 0, "ID3") || hasMp3FrameSync(bytes),
  "audio/ogg": (bytes) => asciiAt(bytes, 0, "OggS"),
  "audio/wav": (bytes) =>
    asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE"),
};

// Number of leading bytes callers need to read to cover every signature
// above (WAV's is the deepest, at bytes 8-11) — small enough that callers
// can slice it off the upload without buffering the whole file.
export const ATTACHMENT_SIGNATURE_PREFIX_BYTES = 16;

// `true` for a content type with no registered signature (images/other
// types are validated elsewhere, or not at all) so callers can run this
// unconditionally rather than special-casing which types it applies to.
export const hasValidAttachmentSignature = (
  contentType: string,
  prefix: Uint8Array,
): boolean => {
  const check = SIGNATURE_CHECKS[contentType];
  return check ? check(prefix) : true;
};
