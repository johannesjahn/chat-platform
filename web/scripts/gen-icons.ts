// Renders the app icon (favicons, PWA icons, logo.png) from one SVG: the
// in-app brand mark's speech bubble (see `BUBBLE` in
// src/components/BrandLogo.tsx) in amber on a navy tile. Run from `web/`
// with `bun scripts/gen-icons.ts` after changing the mark or the palette;
// it writes public/logo.svg and every PNG/ICO next to it. Chromium does the
// rasterising, so the output matches what a browser draws.
import { chromium } from "@playwright/test";

const BUBBLE =
  "M6 4h20a4 4 0 0 1 4 4v11a4 4 0 0 1-4 4H14.5l-6 5v-5H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z";
const DOTS = [10.5, 16, 21.5];

const NAVY_TOP = "#34507a";
const NAVY_BOTTOM = "#1b2a44";
const AMBER = "#ffc100";
const RUST = "#ba2f08";

// At tab-icon sizes the glow turns to mud and a thin stroke vanishes, so the
// small variant drops the glow and thickens the line.
function iconSvg(small: boolean): string {
  const stroke = small ? 3.4 : 2.5;
  const scale = small ? 13.5 : 11;
  const offset = 256 - 16 * scale;
  const glow = small
    ? ""
    : `<circle cx="256" cy="256" r="210" fill="url(#glow)"/>`;
  const dots = DOTS.map(
    (cx) =>
      `<circle cx="${cx}" cy="13.5" r="${small ? 2.4 : 2}" fill="${AMBER}"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${NAVY_TOP}"/>
      <stop offset="1" stop-color="${NAVY_BOTTOM}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.55" r="0.5">
      <stop offset="0" stop-color="${RUST}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${RUST}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="${small ? 96 : 112}" fill="url(#tile)"/>
  ${glow}
  <g transform="translate(${offset} ${offset + (small ? 4 : 6)}) scale(${scale})">
    <path d="${BUBBLE}" fill="none" stroke="${AMBER}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  </g>
</svg>
`;
}

const SIZES = [16, 32, 48, 96, 128, 192, 256, 512];
const ICO_SIZES = [16, 32, 48];
const OUT = new URL("../public/", import.meta.url);

const browser = await chromium.launch();
const page = await browser.newPage();

async function render(size: number): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${iconSvg(size <= 48)}`,
  );
  return page.screenshot({ omitBackground: true });
}

const pngs = new Map<number, Buffer>();
for (const size of SIZES) {
  const png = await render(size);
  pngs.set(size, png);
  await Bun.write(new URL(`favicon-${size}x${size}.png`, OUT), png);
}
await Bun.write(new URL("logo.png", OUT), await render(1024));
await Bun.write(new URL("logo.svg", OUT), iconSvg(false));
await browser.close();

// An ICO is a directory of embedded PNGs: a 6-byte header, then one 16-byte
// entry per image, then the images themselves.
const images = ICO_SIZES.map((size) => pngs.get(size)!);
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((png, i) => {
  const entry = 6 + 16 * i;
  const size = ICO_SIZES[i]!;
  header.writeUInt8(size, entry);
  header.writeUInt8(size, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await Bun.write(
  new URL("favicon.ico", OUT),
  Buffer.concat([header, ...images]),
);
