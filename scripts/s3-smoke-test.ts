/**
 * Smoke test for the configured S3-compatible attachment store (issue #424).
 *
 * Goes through the app's own `S3AttachmentStorageLive` (the same code path as
 * uploads, the avatar proxy, and the orphan sweep): uploads a small object,
 * reads it back, then prints a presigned GET URL for it to stdout — signed
 * against `S3_PUBLIC_ENDPOINT` when that's set, exactly as a browser would
 * receive one. Fetching that URL from *outside* this process (CI curls it from
 * the host, against the compose stack's host-mapped port) is what proves the
 * public-endpoint signing actually works end to end, rather than just
 * producing a plausible-looking URL.
 *
 * The object is left in place so the URL stays fetchable; it lives under a
 * `smoke-test/` prefix that nothing else reads, so it's harmless.
 *
 *   docker compose exec -T app bun scripts/s3-smoke-test.ts
 */
import { Effect } from "effect";
import {
  AttachmentStorage,
  S3AttachmentStorageLive,
} from "../src/AttachmentStorage.ts";

if (!process.env.S3_ENDPOINT) {
  console.error("[s3-smoke-test] S3_ENDPOINT is not set — nothing to test.");
  process.exit(1);
}

// CI compares the presigned download against this exact string (see the
// `docker` job in .github/workflows/ci.yml).
const SMOKE_TEST_BODY = "chat-platform s3 smoke test";

const program = Effect.gen(function* () {
  const storage = yield* AttachmentStorage;
  const key = `smoke-test/${crypto.randomUUID()}.txt`;
  const body = new TextEncoder().encode(SMOKE_TEST_BODY);

  yield* storage.upload(key, body, "text/plain");

  const readBack = yield* storage.get(key);
  if (!readBack || new TextDecoder().decode(readBack) !== SMOKE_TEST_BODY) {
    return yield* Effect.fail(
      new Error(`Read back unexpected content for ${key}`),
    );
  }

  return storage.presignGetUrl(key);
}).pipe(Effect.provide(S3AttachmentStorageLive));

const url = await Effect.runPromise(program);
console.error(`[s3-smoke-test] uploaded and read back: ${SMOKE_TEST_BODY}`);
console.log(url);
