/**
 * Pre-mints Google ID tokens for the k6 load-test accounts (issue #693).
 *
 * Usage:  bun run loadtest:tokens [count]   # default 20 per scenario
 *
 * Every account signs in with Google now, and k6 can't easily do the RS256
 * signing an ID token needs — so this signs them up front with the test key
 * (src/GoogleTestSigner.ts) and writes `google-id-tokens.json` next to this
 * file, mapping each username (`loadtest-http-0`, `loadtest-ws-0`, …) to a
 * token for its Google account. `lib/api.js` reads it. Tokens are good for an
 * hour, so re-run this before a later session.
 *
 * The target backend must trust the test key: GOOGLE_CLIENT_ID and
 * GOOGLE_TEST_PUBLIC_KEY set as in scripts/loadtest/README.md — which a
 * production process refuses to start with.
 */
import path from "node:path";
import { googleSubFor, mintGoogleIdToken } from "../../src/GoogleTestSigner.ts";

const count = Number(process.argv[2] ?? 20);
if (!Number.isInteger(count) || count < 1) {
  console.error("Usage: bun run loadtest:tokens [count]");
  process.exit(2);
}

const tokens: Record<string, string> = {};
for (const scenario of ["http", "ws"]) {
  for (let i = 0; i < count; i++) {
    const username = `loadtest-${scenario}-${i}`;
    tokens[username] = await mintGoogleIdToken({ sub: googleSubFor(username) });
  }
}

const out = path.join(import.meta.dir, "google-id-tokens.json");
await Bun.write(out, JSON.stringify(tokens, null, 2) + "\n");
console.log(
  `[loadtest] Wrote ${Object.keys(tokens).length} ID tokens to ${out}`,
);
