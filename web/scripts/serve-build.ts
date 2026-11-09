// Serves the production build on the e2e suite's web port — the `webServer`
// playwright.config.ts starts under `E2E_TARGET=build`. Build first
// (`bun run build`); in CI, the `e2e` job downloads build-web's artifact.
import { existsSync } from "node:fs";
import { DIST, serveBuild } from "./staticServer";

if (!existsSync(`${DIST}/index.html`)) {
  console.error(`No build in ${DIST} — run \`bun run build\` first.`);
  process.exit(1);
}

const server = serveBuild({ port: Number(process.env.PORT ?? 3001) });
console.log(`Serving ${DIST} at ${server.url}`);
