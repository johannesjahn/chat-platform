import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  AttachmentStorage,
  S3AttachmentStorageLive,
} from "./AttachmentStorage.ts";

const ENV_KEYS = [
  "S3_BUCKET_NAME",
  "S3_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.S3_BUCKET_NAME = "test-bucket";
  process.env.S3_ENDPOINT = "http://internal-minio:9000";
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY_ID = "test-access-key";
  process.env.S3_SECRET_ACCESS_KEY = "test-secret-key";
  delete process.env.S3_PUBLIC_ENDPOINT;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const presignGetUrl = (key: string) =>
  Effect.gen(function* () {
    const storage = yield* AttachmentStorage;
    return storage.presignGetUrl(key);
  }).pipe(Effect.provide(S3AttachmentStorageLive), Effect.runPromise);

test("presignGetUrl signs against S3_ENDPOINT when no public endpoint is configured", async () => {
  const url = new URL(await presignGetUrl("attachments/some-key"));

  expect(url.hostname).toBe("internal-minio");
  expect(url.port).toBe("9000");
});

test("presignGetUrl signs against S3_PUBLIC_ENDPOINT's host and port directly, not by rewriting the S3_ENDPOINT URL (#246)", async () => {
  process.env.S3_PUBLIC_ENDPOINT = "https://s3.chat-platform.example.com";

  const url = new URL(await presignGetUrl("attachments/some-key"));

  // The bug this guards against: rewriting the URL string *after* signing
  // (e.g. only swapping `.host`) can leave the internal port in place, or —
  // even when the host swap looks right — invalidates the signature, since
  // `X-Amz-SignedHeaders=host` bakes the Host header into what was signed.
  // Getting the assertions below right requires actually presigning against
  // the public endpoint, not string surgery on a URL signed for the
  // internal one.
  expect(url.hostname).toBe("s3.chat-platform.example.com");
  expect(url.port).toBe("");
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
});

test("presignGetUrl clears the internal port when the public endpoint has none, and honors an explicit public port", async () => {
  process.env.S3_PUBLIC_ENDPOINT = "https://s3.example.com:8443";

  const url = new URL(await presignGetUrl("attachments/some-key"));

  expect(url.hostname).toBe("s3.example.com");
  expect(url.port).toBe("8443");
});
