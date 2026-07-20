import { expect, test } from "bun:test";
import { hasValidAttachmentSignature } from "./AttachmentSignature.ts";

const bytes = (...values: ReadonlyArray<number>): Uint8Array =>
  new Uint8Array(values);

const asciiBytes = (s: string): ReadonlyArray<number> =>
  Array.from(s, (c) => c.charCodeAt(0));

test("hasValidAttachmentSignature accepts an MP4 ftyp box", () => {
  // Real container prefix shape: 4-byte box size, then ASCII "ftyp".
  const prefix = bytes(0x00, 0x00, 0x00, 0x18, ...asciiBytes("ftyp"));
  expect(hasValidAttachmentSignature("video/mp4", prefix)).toBe(true);
});

test("hasValidAttachmentSignature rejects non-MP4 bytes claiming video/mp4", () => {
  expect(hasValidAttachmentSignature("video/mp4", bytes(1, 2, 3, 4))).toBe(
    false,
  );
});

test("hasValidAttachmentSignature accepts WebM's EBML magic", () => {
  const prefix = bytes(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4);
  expect(hasValidAttachmentSignature("video/webm", prefix)).toBe(true);
});

test("hasValidAttachmentSignature rejects non-WebM bytes claiming video/webm", () => {
  expect(hasValidAttachmentSignature("video/webm", bytes(1, 2, 3, 4))).toBe(
    false,
  );
});

test("hasValidAttachmentSignature accepts an ID3-tagged MP3", () => {
  const prefix = bytes(...asciiBytes("ID3"), 3, 0, 0, 0, 0, 0, 0);
  expect(hasValidAttachmentSignature("audio/mpeg", prefix)).toBe(true);
});

test("hasValidAttachmentSignature accepts a bare MPEG frame sync", () => {
  const prefix = bytes(0xff, 0xfb, 0x90, 0x00);
  expect(hasValidAttachmentSignature("audio/mpeg", prefix)).toBe(true);
});

test("hasValidAttachmentSignature rejects non-MP3 bytes claiming audio/mpeg", () => {
  expect(hasValidAttachmentSignature("audio/mpeg", bytes(1, 2, 3, 4))).toBe(
    false,
  );
});

test("hasValidAttachmentSignature accepts Ogg's OggS magic", () => {
  const prefix = bytes(...asciiBytes("OggS"), 0, 2, 0);
  expect(hasValidAttachmentSignature("audio/ogg", prefix)).toBe(true);
});

test("hasValidAttachmentSignature rejects non-Ogg bytes claiming audio/ogg", () => {
  expect(hasValidAttachmentSignature("audio/ogg", bytes(1, 2, 3, 4))).toBe(
    false,
  );
});

test("hasValidAttachmentSignature accepts a RIFF/WAVE header", () => {
  const prefix = bytes(
    ...asciiBytes("RIFF"),
    0x24,
    0x00,
    0x00,
    0x00,
    ...asciiBytes("WAVE"),
  );
  expect(hasValidAttachmentSignature("audio/wav", prefix)).toBe(true);
});

test("hasValidAttachmentSignature rejects RIFF without a WAVE tag", () => {
  const prefix = bytes(
    ...asciiBytes("RIFF"),
    0x24,
    0x00,
    0x00,
    0x00,
    ...asciiBytes("AVI "),
  );
  expect(hasValidAttachmentSignature("audio/wav", prefix)).toBe(false);
});

test("hasValidAttachmentSignature rejects non-WAV bytes claiming audio/wav", () => {
  expect(hasValidAttachmentSignature("audio/wav", bytes(1, 2, 3, 4))).toBe(
    false,
  );
});

test("hasValidAttachmentSignature passes through content types with no defined signature", () => {
  expect(hasValidAttachmentSignature("image/png", bytes(1, 2, 3, 4))).toBe(
    true,
  );
});

test("hasValidAttachmentSignature tolerates a shorter-than-expected prefix", () => {
  expect(
    hasValidAttachmentSignature("audio/wav", bytes(...asciiBytes("RI"))),
  ).toBe(false);
});
