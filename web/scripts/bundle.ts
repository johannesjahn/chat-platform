// Shared by analyze-bundle.ts and check-bundle-size.ts: where the client
// build lands and which of its chunks a cold load fetches before hydration.
import { readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

export const ASSETS_DIR = "dist/client/assets";

export const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;

export function assetFiles(): string[] {
  return readdirSync(ASSETS_DIR);
}

export function entryChunk(): string {
  const entry = assetFiles().find((f) => /^index-.*\.js$/.test(f));
  if (!entry) throw new Error(`No entry chunk in ${ASSETS_DIR} — build first.`);
  return entry;
}

// The client entry chunk plus every chunk it statically imports (dynamic
// `import()` targets — lazy routes and shell pieces — don't count).
export async function criticalChunks(): Promise<Set<string>> {
  const critical = new Set<string>();
  const pending = [entryChunk()];
  while (pending.length) {
    const file = pending.pop()!;
    if (critical.has(file)) continue;
    critical.add(file);
    const code = await Bun.file(`${ASSETS_DIR}/${file}`).text();
    for (const m of code.matchAll(
      /(?:^|[;}\n])\s*import\s*(?:[^"'()]*?from\s*)?["']\.\/([^"']+)["']/g,
    )) {
      pending.push(m[1]!);
    }
  }
  return critical;
}

export async function sizes(
  file: string,
): Promise<{ raw: number; gzip: number }> {
  const bytes = await Bun.file(`${ASSETS_DIR}/${file}`).bytes();
  return { raw: bytes.length, gzip: gzipSync(bytes).length };
}
