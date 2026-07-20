import { expect, test } from "bun:test";
import sharp from "sharp";
import {
  AVATAR_VARIANT_PX,
  MIN_AVATAR_SOURCE_PX,
  processAvatar,
  processImage,
} from "./ImageProcessing.ts";

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

// Four solid-colored quadrants — lets a test assert *which* region of the
// source `processAvatar` actually kept, not just the output's dimensions.
const makeQuadrantImage = async (size: number): Promise<Uint8Array> => {
  const half = size / 2;
  const quadrant = (r: number, g: number, b: number) =>
    sharp({
      create: {
        width: half,
        height: half,
        channels: 3,
        background: { r, g, b },
      },
    })
      .png()
      .toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 10, g: 10, b: 10 },
    },
  })
    .composite([
      { input: await quadrant(255, 0, 0), left: 0, top: 0 }, // top-left: red
      { input: await quadrant(0, 255, 0), left: half, top: 0 }, // top-right: green
      { input: await quadrant(0, 0, 255), left: 0, top: half }, // bottom-left: blue
      { input: await quadrant(255, 255, 0), left: half, top: half }, // bottom-right: yellow
    ])
    .png()
    .toBuffer();
};

const averageColor = async (
  data: Uint8Array,
): Promise<{ r: number; g: number; b: number }> => {
  const { data: raw, info } = await sharp(data)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = info.width * info.height;
  for (let i = 0; i < raw.length; i += info.channels) {
    r += raw[i]!;
    g += raw[i + 1]!;
    b += raw[i + 2]!;
  }
  return { r: r / pixels, g: g / pixels, b: b / pixels };
};

test("processAvatar crops the chosen square region before resizing into the 3 fixed sizes", async () => {
  const size = 512;
  const input = await makeQuadrantImage(size);
  const half = size / 2;

  // Crop the top-right (green) quadrant.
  const processed = await processAvatar(input, { x: half, y: 0, size: half });
  expect(processed.contentType).toBe("image/webp");

  for (const [variant, target] of [
    ["small", AVATAR_VARIANT_PX.small],
    ["medium", AVATAR_VARIANT_PX.medium],
    ["large", AVATAR_VARIANT_PX.large],
  ] as const) {
    const bytes = processed[variant];
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(target);
    expect(meta.height).toBe(target);

    const avg = await averageColor(bytes);
    expect(avg.r).toBeLessThan(50);
    expect(avg.g).toBeGreaterThan(200);
    expect(avg.b).toBeLessThan(50);
  }
});

test("processAvatar rejects a source image smaller than MIN_AVATAR_SOURCE_PX", async () => {
  const input = await sharp({
    create: {
      width: MIN_AVATAR_SOURCE_PX - 1,
      height: MIN_AVATAR_SOURCE_PX - 1,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .png()
    .toBuffer();

  await expect(
    processAvatar(input, { x: 0, y: 0, size: 100 }),
  ).rejects.toThrow();
});

test("processAvatar rejects a crop region outside the image bounds", async () => {
  const input = await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .png()
    .toBuffer();

  await expect(
    processAvatar(input, { x: 400, y: 400, size: 200 }),
  ).rejects.toThrow();
});

test("processAvatar strips EXIF/GPS metadata from every stored variant (mirrors #258 for avatars)", async () => {
  const input = await makeJpegWithGpsExif(512, 512);
  const processed = await processAvatar(input, { x: 0, y: 0, size: 512 });

  for (const variant of ["small", "medium", "large"] as const) {
    const outputMeta = await sharp(processed[variant]).metadata();
    expect(outputMeta.exif).toBeUndefined();
  }
});
