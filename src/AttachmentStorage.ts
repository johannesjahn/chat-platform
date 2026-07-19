import { S3Client, type BunFile } from "bun";
import { Context, Effect, Layer } from "effect";

// Storage backend for uploaded files (issue #221). Only ever writes/reads by
// `storageKey` (see `attachments.storageKey` in db/schema.ts) — filenames,
// mime types, and sizes are tracked in Postgres, not derived from the
// bucket.
export class AttachmentStorage extends Context.Tag("AttachmentStorage")<
  AttachmentStorage,
  {
    readonly upload: (
      key: string,
      file: BunFile,
      contentType: string,
    ) => Effect.Effect<void, unknown>;
    // Synchronous by design: a presigned S3 URL is just a locally-computed
    // signature (no network round trip), and the in-memory fallback below
    // already holds the bytes it needs. Keeping this sync means callers can
    // compute a fresh, never-stale URL on every read without threading an
    // extra async step through every message/post-building helper.
    readonly presignGetUrl: (key: string) => string;
  }
>() {}

// A presigned GET URL is only ever handed to a caller the corresponding
// message/post/chat read already authorized (see resolveAttachment(s) in
// attachments.ts) — the URL itself carries no further access control, so it
// has to expire soon after being minted rather than staying valid
// indefinitely.
const PRESIGNED_URL_TTL_SECONDS = 15 * 60;

// Real S3-compatible backend (AWS S3, Cloudflare R2, GCS's S3-compat API, or
// MinIO in local/in-cluster dev — see k8s/chat-platform's `minio.enabled`
// values flag and docker-compose.yml) via Bun's native `S3Client`. Used
// whenever `S3_ENDPOINT` is configured.
export const S3AttachmentStorageLive = Layer.sync(AttachmentStorage, () => {
  const client = new S3Client({
    bucket: process.env.S3_BUCKET_NAME,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  });

  // `S3_ENDPOINT` is what *this process* uses to reach the bucket — inside
  // docker-compose/Kubernetes that's normally an internal service hostname
  // (e.g. `http://minio:9000`), which isn't reachable from a browser holding
  // a presigned URL. When the browser-facing address differs,
  // `S3_PUBLIC_ENDPOINT` overrides just the scheme+host+port of presigned
  // URLs, leaving the path/query (and therefore the signature) untouched.
  // Left unset for real cloud storage, where both are the same public
  // endpoint.
  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  const rewritePublicHost = (url: string): string => {
    if (!publicEndpoint) return url;
    const rewritten = new URL(url);
    const publicUrl = new URL(publicEndpoint);
    rewritten.protocol = publicUrl.protocol;
    rewritten.hostname = publicUrl.hostname;
    rewritten.port = publicUrl.port;
    return rewritten.toString();
  };

  return {
    upload: (key, file, contentType) =>
      Effect.tryPromise(() =>
        client.write(key, file, { type: contentType }),
      ).pipe(Effect.asVoid),
    presignGetUrl: (key) =>
      rewritePublicHost(
        client.presign(key, {
          method: "GET",
          expiresIn: PRESIGNED_URL_TTL_SECONDS,
        }),
      ),
  };
});

// Local-dev/test fallback when `S3_ENDPOINT` is unset — mirrors
// PGlite/InMemoryPubSubLive's "no external service configured" idiom (see
// Db.ts/PubSub.ts). Holds uploaded bytes in process memory and serves them
// back as `data:` URLs rather than real presigned links, since there's no
// bucket to presign against; fine for local development and tests, but
// obviously not for anything beyond a single process, so `docker compose up`
// and the Helm chart both always configure a real S3-compatible endpoint.
export const InMemoryAttachmentStorageLive = Layer.sync(
  AttachmentStorage,
  () => {
    const store = new Map<string, { data: Uint8Array; contentType: string }>();

    return {
      upload: (key, file, contentType) =>
        Effect.tryPromise(async () => {
          const data = new Uint8Array(await file.arrayBuffer());
          store.set(key, { data, contentType });
        }),
      presignGetUrl: (key) => {
        const entry = store.get(key);
        if (!entry) return "";
        return `data:${entry.contentType};base64,${Buffer.from(entry.data).toString("base64")}`;
      },
    };
  },
);

export const AttachmentStorageLive = process.env.S3_ENDPOINT
  ? S3AttachmentStorageLive
  : InMemoryAttachmentStorageLive;
