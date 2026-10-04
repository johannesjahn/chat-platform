import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Encodes a minimal, solid-color RGB PNG from scratch (raw IHDR/IDAT/IEND
// chunks via node:zlib's deflate) — enough for e2e tests that need a real,
// decodable image file (e.g. the avatar upload flow) without pulling a
// native image library into the otherwise pure-JS frontend package just for
// test fixtures.
export function makeSolidPng(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor (RGB), no alpha
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method

  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // per-row filter type: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
    }
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A unique username per run so repeated runs never collide on the (unique)
// username column. Hex, not base64url: base64url's alphabet includes "-",
// and a name ending in one (~1 in 64) isn't `@mention`able — the mention
// parser hands trailing "."/"-" back to the prose (see `isMentionable` in
// src/lib/mentions.ts), so the composer offers no suggestion and a posted
// mention neither links nor notifies. Hex also keeps "_" (a LIKE wildcard)
// out of the fragments tests search by.
export function randomUsername(): string {
  return `u_${randomBytes(9).toString("hex")}`;
}

declare global {
  interface Window {
    // Installed by `fakeOnScreenKeyboard` below.
    __shrinkVisualViewport: (height: number | null, offsetTop?: number) => void;
  }
}

// Stands in for an on-screen keyboard, which no browser automation can
// actually raise. A real one shrinks only the *visual* viewport on iOS Safari
// (and on Android Chrome's `resizes-visual` default) while the layout
// viewport — and so `100dvh` — stays at full height, and iOS pans that visual
// viewport down the layout one (`offsetTop`) to keep the focused field clear.
// Playwright's `setViewportSize` moves both together and never pans, so the
// divergence is faked here by overriding what `visualViewport` reports and
// firing the events the browser would have. Call before navigating, then drive
// it from the test with `page.evaluate(() => window.__shrinkVisualViewport(400))`
// — optionally with a pan, `(400, 60)` — and `null` to put the keyboard away.
export async function fakeOnScreenKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const viewport = window.visualViewport!;
    const prototype = Object.getPrototypeOf(viewport);
    const realHeight = Object.getOwnPropertyDescriptor(prototype, "height")!;
    const realOffsetTop = Object.getOwnPropertyDescriptor(
      prototype,
      "offsetTop",
    )!;
    let height: number | null = null;
    let offsetTop = 0;
    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: () => height ?? realHeight.get!.call(viewport),
    });
    Object.defineProperty(viewport, "offsetTop", {
      configurable: true,
      get: () => offsetTop || realOffsetTop.get!.call(viewport),
    });
    Object.defineProperty(window, "__shrinkVisualViewport", {
      value: (nextHeight: number | null, nextOffsetTop = 0) => {
        height = nextHeight;
        offsetTop = nextOffsetTop;
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      },
    });
  });
}

// Everything the query persister has written to localStorage, across every
// per-user slot (`chat-platform-query-cache:<userId>`, see src/lib/query.ts),
// joined into one string for `toContain`-style assertions.
export function persistedQueryCache(page: Page): Promise<string> {
  return page.evaluate(() =>
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith("chat-platform-query-cache"))
      .map((key) => window.localStorage.getItem(key) ?? "")
      .join("\n"),
  );
}
