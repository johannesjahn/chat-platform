// Generates openapi.json from the ChatApi definition (no server needed).
// Consumed by the web frontend to generate TypeScript types.
import { OpenApi } from "@effect/platform";
import { ChatApi } from "../src/Api.ts";

const spec = OpenApi.fromApi(ChatApi);
const outPath = new URL("../openapi.json", import.meta.url).pathname;
await Bun.write(outPath, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
