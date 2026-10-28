// Fails when the production client build outgrows bundle-budget.json — the
// `build-web` CI job runs it right after `bun run build`. Unlike a Lighthouse
// performance score, byte counts don't change from run to run, so this can
// gate a PR without flaking. Three numbers, all gzipped:
//
// - criticalJsGzipBytes: what a cold load fetches before hydration (the entry
//   chunk and everything it statically imports, as `bun run analyze`
//   reports it) — the one that decides how fast the app first paints.
// - totalJsGzipBytes: every JS chunk, lazy routes included, so a heavy
//   dependency can't sneak in behind a dynamic import unnoticed.
// - totalCssGzipBytes: the stylesheet(s).
//
// Run from `web/` after a build: `bun run check:bundle`. A deliberate
// increase is fine — raise the budget in the same PR, so the review sees
// it; `bun run analyze` shows what the entry chunk is made of.
import { appendFileSync } from "node:fs";
import { assetFiles, criticalChunks, kB, sizes } from "./bundle";

type Budget = {
  criticalJsGzipBytes: number;
  totalJsGzipBytes: number;
  totalCssGzipBytes: number;
};

const budget = (await Bun.file(
  new URL("../bundle-budget.json", import.meta.url),
).json()) as Budget;

async function gzipTotal(files: Iterable<string>): Promise<number> {
  let total = 0;
  for (const file of files) total += (await sizes(file)).gzip;
  return total;
}

const files = assetFiles();
const rows = [
  {
    name: "JS before hydration",
    key: "criticalJsGzipBytes",
    actual: await gzipTotal(await criticalChunks()),
  },
  {
    name: "All JS",
    key: "totalJsGzipBytes",
    actual: await gzipTotal(files.filter((f) => f.endsWith(".js"))),
  },
  {
    name: "All CSS",
    key: "totalCssGzipBytes",
    actual: await gzipTotal(files.filter((f) => f.endsWith(".css"))),
  },
] as const;

const lines = [
  "| Bundle (gzip) | Size | Budget | Used |",
  "| --- | ---: | ---: | ---: |",
];
let failed = false;
for (const { name, key, actual } of rows) {
  const limit = budget[key];
  const over = actual > limit;
  failed ||= over;
  const used = `${((actual / limit) * 100).toFixed(1)}%`;
  lines.push(
    `| ${name} | ${kB(actual)} | ${kB(limit)} | ${over ? `❌ ${used}` : used} |`,
  );
  if (over) {
    console.error(
      `::error::${name} is ${kB(actual)} gzipped, over its ${kB(limit)} budget (${key} in web/bundle-budget.json). Shrink it, or raise the budget in this PR if the growth is deliberate.`,
    );
  }
}

const table = lines.join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
}
if (failed) process.exit(1);
