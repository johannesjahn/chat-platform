import { expect, test } from "bun:test";
import sharp from "sharp";
import { processImage } from "./ImageProcessing.ts";

// GPS coordinates and device info embedded via EXIF, the way a real
// phone/camera photo would carry them — processImage re-encodes rescalable
// images without `.withMetadata()`, so none of this should survive into the
// stored output (issue #258).
const GPS_LATITUDE = "37/1 46/1 2938/100";
const GPS_LONGITUDE = "122/1 25/1 900/100";
const DEVICE_MAKE = "ExampleCam";
const DEVICE_MODEL = "PrivacyLeakTest-9000";

const makeJpegWithGpsExif = (
  width: number,
  height: number,
): Promise<Uint8Array> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 180, b: 220 },
    },
  })
    .withExif({
      IFD0: { Make: DEVICE_MAKE, Model: DEVICE_MODEL },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: GPS_LATITUDE,
        GPSLongitudeRef: "W",
        GPSLongitude: GPS_LONGITUDE,
      },
    })
    .jpeg()
    .toBuffer();

test("processImage strips EXIF/GPS metadata from a re-encoded image (#258)", async () => {
  const input = await makeJpegWithGpsExif(64, 64);

  // Sanity check the fixture itself actually carries EXIF data (including
  // the GPS IFD), so this test can't pass vacuously if the fixture ever
  // stops embedding it. GPS lat/long are stored as binary EXIF rationals
  // rather than literal ASCII, so we check the ASCII device fields — Make
  // and Model live in the same EXIF blob as the GPS IFD.
  const inputMeta = await sharp(input).metadata();
  expect(inputMeta.exif).toBeDefined();
  const inputExifText = inputMeta.exif!.toString("latin1");
  expect(inputExifText).toContain(DEVICE_MODEL);
  expect(inputExifText).toContain(DEVICE_MAKE);

  const processed = await processImage(input, "image/jpeg");

  // The entire EXIF blob — GPS IFD included — must be gone, not merely the
  // fields we happen to be able to assert on textually.
  const outputMeta = await sharp(processed.data).metadata();
  expect(outputMeta.exif).toBeUndefined();

  // Belt-and-suspenders: no trace of the device strings anywhere in the raw
  // output bytes, not just absent from the parsed EXIF block.
  const outputText = Buffer.from(processed.data).toString("latin1");
  expect(outputText).not.toContain(DEVICE_MODEL);
  expect(outputText).not.toContain(DEVICE_MAKE);
});

// Trailing bytes appended after a GIF's valid trailer (0x3B) aren't part of
// what any GIF decoder reads — sharp included — so if `processImage` ever
// regresses to passing GIF bytes through unchanged (issue #257), this exact
// marker would ride along into what gets served to other users.
const SMUGGLED_MARKER = "SMUGGLED-PAYLOAD-AFTER-GIF-TRAILER";

const makeAnimatedGif = async (
  width: number,
  height: number,
): Promise<Uint8Array> => {
  const frame = async (r: number, g: number, b: number) =>
    sharp({
      create: { width, height, channels: 3, background: { r, g, b } },
    })
      .png()
      .toBuffer();
  const frames = [
    await frame(255, 0, 0),
    await frame(0, 255, 0),
    await frame(0, 0, 255),
  ];
  const gif = await sharp(frames, { join: { animated: true } })
    .gif()
    .toBuffer();
  return new Uint8Array(
    Buffer.concat([gif, Buffer.from(SMUGGLED_MARKER, "latin1")]),
  );
};

test("processImage re-encodes animated GIFs instead of passing original bytes through (#257)", async () => {
  const input = await makeAnimatedGif(40, 30);

  const inputMeta = await sharp(input, { animated: true }).metadata();
  expect(inputMeta.pages).toBe(3);

  const processed = await processImage(input, "image/gif");

  // The whole point: stored/served bytes must be sharp's re-encode output,
  // not the uploaded bytes verbatim — so nothing appended past the GIF
  // trailer survives.
  const outputText = Buffer.from(processed.data).toString("latin1");
  expect(outputText).not.toContain(SMUGGLED_MARKER);

  expect(processed.contentType).toBe("image/webp");
  expect(processed.width).toBe(40);
  expect(processed.height).toBe(30);

  const outputMeta = await sharp(processed.data, { animated: true }).metadata();
  expect(outputMeta.pages).toBe(3);
});
