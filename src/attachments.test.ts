import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import sharp from "sharp";
import {
  ChatApi,
  CreateMessageBody,
  CreatePostBody,
  MAX_ATTACHMENT_SIZE_BYTES,
} from "./Api.ts";
import { AttachmentsHandlerLive } from "./AttachmentsHandler.ts";
import { AttachmentStorageLive } from "./AttachmentStorage.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { Db } from "./Db.ts";
import { SanitizeDecodeErrorsLive } from "./DecodeErrorSanitizer.ts";
import { JwtLive } from "./Jwt.ts";
import { EngagementHandlerLive } from "./EngagementHandler.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { InMemoryPubSubLive } from "./PubSub.ts";
import { InMemoryRateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { makeTestDbAccessor, resetTestDb } from "./testDb.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { InMemoryWsTicketLive } from "./WsTicket.ts";

process.env.JWT_SECRET ??= "test-secret";

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(EngagementHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(AttachmentsHandlerLive),
  Layer.provide(VersionHandlerLive),
  Layer.provide(RealtimeHandlerLive),
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(TokenVersionCacheLive),
  Layer.provide(InMemoryPresenceStoreLive),
  Layer.provide(InMemoryRateLimiterLive),
  Layer.provide(JwtLive),
  Layer.provide(SanitizeDecodeErrorsLive),
  Layer.provide(InMemoryWsTicketLive),
  Layer.provide(AttachmentStorageLive),
);

const { getTestDb } = makeTestDbAccessor();

// Unlike the other *.test.ts files' `run`, this also hands the raw
// `handler` to the callback — `POST /attachments` is a multipart endpoint,
// and building a real `multipart/form-data` request body (via `FormData`)
// and driving it straight through the web handler exercises the same wire
// format a browser would use, rather than relying on HttpApiClient's
// (unclear, for multipart) client-side schema encoding.
const run = async <A, E>(
  effect: (ctx: {
    handler: (request: Request) => Promise<Response>;
  }) => Effect.Effect<A, E, HttpClient.HttpClient | Db>,
): Promise<A> => {
  const db = await getTestDb();
  await resetTestDb(db);
  const TestDbLive = Layer.succeed(Db, db);

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(
      ApiLive.pipe(
        Layer.provide(TestDbLive),
        Layer.provide(InMemoryPubSubLive),
      ),
      BunHttpServer.layerContext,
    ),
  );

  const mockFetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> =>
    handler(
      input instanceof Request ? input : new Request(input.toString(), init),
    );

  const TestClientLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, mockFetch as typeof fetch),
    ),
  );

  try {
    return await Effect.runPromise(
      effect({ handler }).pipe(
        Effect.provide(TestClientLayer),
        Effect.provide(TestDbLive),
      ),
    );
  } finally {
    await dispose();
  }
};

const makeAuthedClient = (token: string) =>
  HttpApiClient.make(ChatApi, {
    baseUrl: "http://localhost",
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      ),
  });

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

const registerAndLogin = (username: string, password: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const user = yield* c.users.register({ payload: { username, password } });
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return { user, accessToken };
  });

// Real (decodable) PNG bytes for tests exercising the image-processing path
// (AttachmentsHandler.ts / ImageProcessing.ts, issue #248) — a solid-color
// image is enough to drive scaling/blurhash without needing a fixture file.
const makePng = (width: number, height: number): Promise<Uint8Array> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 180, b: 220 },
    },
  })
    .png()
    .toBuffer();

// Real (decodable) MP4 bytes for tests exercising the video-processing path
// (AttachmentsHandler.ts / VideoProcessing.ts, issue #251) — a short
// solid-color clip generated via ffmpeg's `lavfi` test source is enough to
// drive downscaling without needing a fixture file.
const makeMp4 = async (width: number, height: number): Promise<Uint8Array> => {
  const path = join(tmpdir(), `attachments-test-${crypto.randomUUID()}.mp4`);
  try {
    await Bun.$`ffmpeg -y -f lavfi -i ${`color=c=blue:s=${width}x${height}:d=1:r=5`} -pix_fmt yuv420p -c:v libx264 ${path}`.quiet();
    return await Bun.file(path).bytes();
  } finally {
    await Bun.$`rm -f ${path}`.quiet().nothrow();
  }
};

type UploadResult = { readonly status: number; readonly body: unknown };

// Drives `POST /attachments` with a real multipart/form-data body — the
// shape a browser's `fetch(url, { body: formData })` produces — rather than
// going through the typed HttpApiClient.
const uploadFile = async (
  handler: (request: Request) => Promise<Response>,
  token: string | null,
  file: { filename: string; contentType: string; data: Uint8Array },
): Promise<UploadResult> => {
  const form = new FormData();
  form.append(
    "file",
    new Blob([file.data], { type: file.contentType }),
    file.filename,
  );
  const response = await handler(
    new Request("http://localhost/attachments", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    }),
  );
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

test("uploadAttachment rejects an unauthenticated request", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        uploadFile(handler, null, {
          filename: "photo.png",
          contentType: "image/png",
          data: new Uint8Array([1, 2, 3]),
        }),
      );
      expect(result.status).toBe(401);
    }),
  ));

test("uploadAttachment rejects an unsupported mime type", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "uploader1",
        "pw-testpass",
      );
      const result = yield* Effect.promise(() =>
        uploadFile(handler, accessToken, {
          filename: "script.js",
          contentType: "application/javascript",
          data: new Uint8Array([1, 2, 3]),
        }),
      );
      expect(result.status).toBe(415);
    }),
  ));

test("uploadAttachment rejects a PDF file", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "uploader-pdf",
        "pw-testpass",
      );
      const result = yield* Effect.promise(() =>
        uploadFile(handler, accessToken, {
          filename: "report.pdf",
          contentType: "application/pdf",
          data: new Uint8Array([1, 2, 3, 4, 5]),
        }),
      );
      expect(result.status).toBe(415);
    }),
  ));

test("uploadAttachment rejects a file over the size limit", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "uploader2",
        "pw-testpass",
      );
      const oversized = new Uint8Array(MAX_ATTACHMENT_SIZE_BYTES + 1);
      const result = yield* Effect.promise(() =>
        uploadFile(handler, accessToken, {
          filename: "huge.png",
          contentType: "image/png",
          data: oversized,
        }),
      );
      expect(result.status).toBe(413);
    }),
  ));

test("uploadAttachment stores the file and returns metadata with a usable url", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "uploader3",
        "pw-testpass",
      );
      const data = yield* Effect.promise(() => makePng(40, 30));
      const result = yield* Effect.promise(() =>
        uploadFile(handler, accessToken, {
          filename: "photo.png",
          contentType: "image/png",
          data,
        }),
      );
      expect(result.status).toBe(201);
      const attachment = result.body as {
        id: number;
        filename: string;
        mimeType: string;
        size: number;
        width: number | null;
        height: number | null;
        blurhash: string | null;
        url: string;
      };
      // The original filename is kept as-is even though the stored bytes
      // get transcoded to WebP (see ImageProcessing.ts) — it's just
      // upload/display metadata, not what's actually served.
      expect(attachment.filename).toBe("photo.png");
      expect(attachment.mimeType).toBe("image/webp");
      expect(attachment.size).toBeGreaterThan(0);
      expect(typeof attachment.id).toBe("number");
      // Below the 2048px scaling cap, so dimensions pass through unchanged.
      expect(attachment.width).toBe(40);
      expect(attachment.height).toBe(30);
      expect(typeof attachment.blurhash).toBe("string");
      expect(attachment.blurhash?.length).toBeGreaterThan(0);
      // No real S3/MinIO is configured in tests, so AttachmentStorageLive
      // falls back to the in-memory backend, which serves bytes back as a
      // `data:` URL rather than a presigned link (see AttachmentStorage.ts).
      expect(attachment.url.startsWith("data:image/webp;base64,")).toBe(true);
    }),
  ));

test("uploadAttachment scales an oversized image down to the max dimension", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "uploader-scale",
        "pw-testpass",
      );
      // 3000x1500 exceeds the 2048px longest-edge cap — the 2:1 aspect ratio
      // should be preserved through the scale-down.
      const data = yield* Effect.promise(() => makePng(3000, 1500));
      const result = yield* Effect.promise(() =>
        uploadFile(handler, accessToken, {
          filename: "big.png",
          contentType: "image/png",
          data,
        }),
      );
      expect(result.status).toBe(201);
      const attachment = result.body as {
        size: number;
        width: number | null;
        height: number | null;
        blurhash: string | null;
      };
      expect(attachment.width).toBe(2048);
      expect(attachment.height).toBe(1024);
      expect(attachment.blurhash).not.toBeNull();
      expect(attachment.size).toBeLessThan(data.length);
    }),
  ));

test("uploadAttachment rejects a file claiming an image mime type it isn't", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "uploader-badimg",
        "pw-testpass",
      );
      const result = yield* Effect.promise(() =>
        uploadFile(handler, accessToken, {
          filename: "not-a-photo.png",
          contentType: "image/png",
          data: new Uint8Array([1, 2, 3, 4]),
        }),
      );
      expect(result.status).toBe(415);
    }),
  ));

test("uploadAttachment stores a video file transcoded to webm", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "uploader-video",
        "pw-testpass",
      );
      const data = yield* Effect.promise(() => makeMp4(320, 240));
      const result = yield* Effect.promise(() =>
        uploadFile(handler, accessToken, {
          filename: "clip.mp4",
          contentType: "video/mp4",
          data,
        }),
      );
      expect(result.status).toBe(201);
      const attachment = result.body as {
        filename: string;
        mimeType: string;
        size: number;
        width: number | null;
        height: number | null;
        url: string;
      };
      // The original filename is kept as-is even though the stored bytes
      // get transcoded to WebM (see VideoProcessing.ts) — it's just
      // upload/display metadata, not what's actually served.
      expect(attachment.filename).toBe("clip.mp4");
      expect(attachment.mimeType).toBe("video/webm");
      expect(attachment.size).toBeGreaterThan(0);
      // Below the 1280px scaling cap, so dimensions pass through unchanged.
      expect(attachment.width).toBe(320);
      expect(attachment.height).toBe(240);
      // No real S3/MinIO is configured in tests, so AttachmentStorageLive
      // falls back to the in-memory backend, which serves bytes back as a
      // `data:` URL rather than a presigned link (see AttachmentStorage.ts).
      expect(attachment.url.startsWith("data:video/webm;base64,")).toBe(true);
    }),
  ));

test("uploadAttachment scales an oversized video down to the max dimension", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "uploader-vscale",
        "pw-testpass",
      );
      // 1920x1080 exceeds the 1280px longest-edge cap — the 16:9 aspect
      // ratio should be preserved through the scale-down.
      const data = yield* Effect.promise(() => makeMp4(1920, 1080));
      const result = yield* Effect.promise(() =>
        uploadFile(handler, accessToken, {
          filename: "big.mp4",
          contentType: "video/mp4",
          data,
        }),
      );
      expect(result.status).toBe(201);
      const attachment = result.body as {
        width: number | null;
        height: number | null;
      };
      expect(attachment.width).toBe(1280);
      expect(attachment.height).toBe(720);
    }),
  ));

test("uploadAttachment rejects a file claiming a video mime type it isn't", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "uploader-badvideo",
        "pw-testpass",
      );
      const result = yield* Effect.promise(() =>
        uploadFile(handler, accessToken, {
          filename: "not-a-video.mp4",
          contentType: "video/mp4",
          data: new Uint8Array([1, 2, 3, 4]),
        }),
      );
      expect(result.status).toBe(415);
    }),
  ));

test("createMessage attaches an uploaded file the sender owns", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice-att", "pw-testpass");
      const bob = yield* registerAndLogin("bob-att", "pw-testpass");
      const authedAlice = yield* makeAuthedClient(alice.accessToken);

      const upload = yield* Effect.promise(() =>
        uploadFile(handler, alice.accessToken, {
          filename: "report.mp3",
          contentType: "audio/mpeg",
          data: new Uint8Array([1, 2, 3, 4, 5]),
        }),
      );
      expect(upload.status).toBe(201);
      const attachmentId = (upload.body as { id: number }).id;

      const chat = yield* authedAlice.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* authedAlice.chats.createMessage({
        path: { id: chat.id },
        payload: {
          contentType: "attachment",
          content: "report.mp3",
          attachmentId,
        },
      });
      expect(message.contentType).toBe("attachment");
      expect(message.attachment).not.toBeNull();
      expect(message.attachment?.filename).toBe("report.mp3");
      expect(message.attachment?.mimeType).toBe("audio/mpeg");

      // Reading the message back (as the other participant) resolves a
      // fresh attachment url rather than replaying a stored one.
      const authedBob = yield* makeAuthedClient(bob.accessToken);
      const page = yield* authedBob.chats.listMessages({
        path: { id: chat.id },
        urlParams: {},
      });
      const fetched = page.messages.find((m) => m.id === message.id);
      expect(fetched?.attachment?.filename).toBe("report.mp3");
    }),
  ));

test("createMessage rejects an attachmentId the sender doesn't own", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice-att2", "pw-testpass");
      const bob = yield* registerAndLogin("bob-att2", "pw-testpass");
      const authedBob = yield* makeAuthedClient(bob.accessToken);

      const upload = yield* Effect.promise(() =>
        uploadFile(handler, alice.accessToken, {
          filename: "mine.mp3",
          contentType: "audio/mpeg",
          data: new Uint8Array([1, 2, 3]),
        }),
      );
      const attachmentId = (upload.body as { id: number }).id;

      const chat = yield* authedBob.chats.createDirectChat({
        payload: { userId: alice.user.id },
      });
      const result = yield* authedBob.chats
        .createMessage({
          path: { id: chat.id },
          payload: {
            contentType: "attachment",
            content: "mine.mp3",
            attachmentId,
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));

test("createPost attaches an uploaded file", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "poster-att",
        "pw-testpass",
      );
      const authed = yield* makeAuthedClient(accessToken);

      const data = yield* Effect.promise(() => makeMp4(320, 240));
      const upload = yield* Effect.promise(() =>
        uploadFile(handler, accessToken, {
          filename: "clip.mp4",
          contentType: "video/mp4",
          data,
        }),
      );
      const attachmentId = (upload.body as { id: number }).id;

      const post = yield* authed.posts.createPost({
        payload: {
          contentType: "attachment",
          content: "clip.mp4",
          attachmentId,
        },
      });
      expect(post.contentType).toBe("attachment");
      expect(post.attachment?.filename).toBe("clip.mp4");
      // Stored bytes are transcoded to WebM regardless of the uploaded
      // container/codec — see VideoProcessing.ts.
      expect(post.attachment?.mimeType).toBe("video/webm");
    }),
  ));

// Schema-level checks for the requireAttachmentId cross-field filter — fast,
// no server needed.
test("CreateMessageBody rejects contentType attachment without attachmentId", () => {
  const result = Schema.decodeUnknownEither(CreateMessageBody)({
    contentType: "attachment",
    content: "file.png",
  });
  expect(result._tag).toBe("Left");
});

test("CreateMessageBody rejects attachmentId set alongside contentType text", () => {
  const result = Schema.decodeUnknownEither(CreateMessageBody)({
    contentType: "text",
    content: "hello",
    attachmentId: 1,
  });
  expect(result._tag).toBe("Left");
});

test("CreatePostBody accepts a well-formed attachment payload", () => {
  const result = Schema.decodeUnknownEither(CreatePostBody)({
    contentType: "attachment",
    content: "file.png",
    attachmentId: 1,
  });
  expect(result._tag).toBe("Right");
});
