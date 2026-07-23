import { expect, test } from "bun:test";
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import sharp from "sharp";
import { ChatApi, MAX_AVATAR_UPLOAD_SIZE_BYTES } from "./Api.ts";
import { AttachmentsHandlerLive } from "./AttachmentsHandler.ts";
import { AttachmentStorageLive } from "./AttachmentStorage.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { SearchHandlerLive } from "./SearchHandler.ts";
import { Db } from "./Db.ts";
import { SanitizeDecodeErrorsLive } from "./DecodeErrorSanitizer.ts";
import { JwtLive } from "./Jwt.ts";
import { EngagementHandlerLive } from "./EngagementHandler.ts";
import { AVATAR_VARIANT_PX, MIN_AVATAR_SOURCE_PX } from "./ImageProcessing.ts";
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
  Layer.provide(SearchHandlerLive),
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

// Mirrors attachments.test.ts's `run`: `POST /users/me/avatar` is a
// multipart endpoint, so this hands back the raw web `handler` too, for
// driving it with a real `multipart/form-data` body the way a browser would.
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

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

const makeAuthedClient = (token: string) =>
  HttpApiClient.make(ChatApi, {
    baseUrl: "http://localhost",
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      ),
  });

const registerAndLogin = (username: string, password: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const user = yield* c.users.register({ payload: { username, password } });
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return { user, accessToken };
  });

// Real (decodable) square PNG bytes, at least MIN_AVATAR_SOURCE_PX, for
// tests exercising the happy path.
const makePng = (width: number, height: number): Promise<Uint8Array> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .png()
    .toBuffer();

type UploadResult = { readonly status: number; readonly body: unknown };

// Drives `POST /users/me/avatar` with a real multipart/form-data body,
// mirroring attachments.test.ts's `uploadFile` helper.
const uploadAvatarFile = async (
  handler: (request: Request) => Promise<Response>,
  token: string | null,
  file: { filename: string; contentType: string; data: Uint8Array },
  crop: { x: number; y: number; size: number },
): Promise<UploadResult> => {
  const form = new FormData();
  form.append(
    "file",
    new Blob([file.data], { type: file.contentType }),
    file.filename,
  );
  form.append("x", String(crop.x));
  form.append("y", String(crop.y));
  form.append("size", String(crop.size));
  const response = await handler(
    new Request("http://localhost/users/me/avatar", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    }),
  );
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

test("uploadAvatar rejects an unauthenticated request", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const png = yield* Effect.promise(() =>
        makePng(MIN_AVATAR_SOURCE_PX, MIN_AVATAR_SOURCE_PX),
      );
      const result = yield* Effect.promise(() =>
        uploadAvatarFile(
          handler,
          null,
          { filename: "avatar.png", contentType: "image/png", data: png },
          { x: 0, y: 0, size: MIN_AVATAR_SOURCE_PX },
        ),
      );
      expect(result.status).toBe(401);
    }),
  ));

test("uploadAvatar rejects an unsupported mime type", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "avatarer1",
        "pw-testpass",
      );
      const result = yield* Effect.promise(() =>
        uploadAvatarFile(
          handler,
          accessToken,
          {
            filename: "avatar.gif",
            contentType: "image/gif",
            data: new Uint8Array([1, 2, 3]),
          },
          { x: 0, y: 0, size: 10 },
        ),
      );
      expect(result.status).toBe(400);
      expect((result.body as { _tag: string })._tag).toBe(
        "InvalidAvatarUpload",
      );
    }),
  ));

test("uploadAvatar rejects a source image smaller than the minimum dimensions", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "avatarer2",
        "pw-testpass",
      );
      const png = yield* Effect.promise(() =>
        makePng(MIN_AVATAR_SOURCE_PX - 1, MIN_AVATAR_SOURCE_PX - 1),
      );
      const result = yield* Effect.promise(() =>
        uploadAvatarFile(
          handler,
          accessToken,
          { filename: "avatar.png", contentType: "image/png", data: png },
          { x: 0, y: 0, size: MIN_AVATAR_SOURCE_PX - 1 },
        ),
      );
      expect(result.status).toBe(400);
      expect((result.body as { _tag: string })._tag).toBe(
        "InvalidAvatarUpload",
      );
    }),
  ));

test("uploadAvatar rejects a crop region outside the image bounds", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "avatarer3",
        "pw-testpass",
      );
      const png = yield* Effect.promise(() =>
        makePng(MIN_AVATAR_SOURCE_PX, MIN_AVATAR_SOURCE_PX),
      );
      const result = yield* Effect.promise(() =>
        uploadAvatarFile(
          handler,
          accessToken,
          { filename: "avatar.png", contentType: "image/png", data: png },
          { x: MIN_AVATAR_SOURCE_PX, y: 0, size: 50 },
        ),
      );
      expect(result.status).toBe(400);
      expect((result.body as { _tag: string })._tag).toBe(
        "InvalidAvatarUpload",
      );
    }),
  ));

test("uploadAvatar rejects a file over the size limit", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "avatarer4",
        "pw-testpass",
      );
      const oversized = new Uint8Array(MAX_AVATAR_UPLOAD_SIZE_BYTES + 1);
      const result = yield* Effect.promise(() =>
        uploadAvatarFile(
          handler,
          accessToken,
          {
            filename: "avatar.png",
            contentType: "image/png",
            data: oversized,
          },
          { x: 0, y: 0, size: MIN_AVATAR_SOURCE_PX },
        ),
      );
      expect(result.status).toBe(413);
      expect((result.body as { _tag: string })._tag).toBe("AvatarTooLarge");
    }),
  ));

test("uploadAvatar stores 3 fixed-size variants, clears avatarUrl, and is reflected by getUser", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { user, accessToken } = yield* registerAndLogin(
        "avatarer5",
        "pw-testpass",
      );
      const authed = yield* makeAuthedClient(accessToken);

      // Give the account an external avatarUrl first, so the upload below
      // can prove it gets cleared (the two are mutually exclusive).
      yield* authed.users.updateProfile({
        payload: {
          displayName: null,
          avatarUrl: "https://i.imgur.com/avatar.png",
        },
      });

      const size = 400;
      const png = yield* Effect.promise(() => makePng(size, size));
      const result = yield* Effect.promise(() =>
        uploadAvatarFile(
          handler,
          accessToken,
          { filename: "avatar.png", contentType: "image/png", data: png },
          { x: 0, y: 0, size },
        ),
      );
      expect(result.status).toBe(200);

      const body = result.body as {
        avatarUrl: string | null;
        avatarVariants: { small: string; medium: string; large: string } | null;
      };
      expect(body.avatarUrl).toBeNull();
      expect(body.avatarVariants).not.toBeNull();
      expect(
        body.avatarVariants!.small.startsWith("data:image/webp;base64,"),
      ).toBe(true);

      const smallBytes = Buffer.from(
        body.avatarVariants!.small.split(",")[1]!,
        "base64",
      );
      const smallMeta = yield* Effect.promise(() =>
        sharp(smallBytes).metadata(),
      );
      expect(smallMeta.width).toBe(AVATAR_VARIANT_PX.small);
      expect(smallMeta.height).toBe(AVATAR_VARIANT_PX.small);

      const fetched = yield* authed.users.getUser({ path: { id: user.id } });
      expect(fetched.avatarUrl).toBeNull();
      expect(fetched.avatarVariants).toEqual(body.avatarVariants);
    }),
  ));

test("updateProfile clears an uploaded avatar back to an external avatarUrl", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "avatarer6",
        "pw-testpass",
      );
      const authed = yield* makeAuthedClient(accessToken);

      const size = 300;
      const png = yield* Effect.promise(() => makePng(size, size));
      yield* Effect.promise(() =>
        uploadAvatarFile(
          handler,
          accessToken,
          { filename: "avatar.png", contentType: "image/png", data: png },
          { x: 0, y: 0, size },
        ),
      );

      const updated = yield* authed.users.updateProfile({
        payload: {
          displayName: null,
          avatarUrl: "https://i.imgur.com/avatar.png",
        },
      });
      expect(updated.avatarUrl).toBe("https://i.imgur.com/avatar.png");
      expect(updated.avatarVariants).toBeNull();
    }),
  ));
