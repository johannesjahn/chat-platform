import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect } from "effect";
import sharp from "sharp";
import { ChatApi, MAX_AVATAR_UPLOAD_SIZE_BYTES } from "./Api.ts";
import { AvatarRouteLive } from "./AvatarRoute.ts";
import { AVATAR_VARIANT_PX, MIN_AVATAR_SOURCE_PX } from "./ImageProcessing.ts";
import { makeTestRun } from "./testApi.ts";

process.env.JWT_SECRET ??= "test-secret";

// Mirrors attachments.test.ts's `run`: `POST /users/me/avatar` is a
// multipart endpoint, so this hands back the raw web `handler` too, for
// driving it with a real `multipart/form-data` body the way a browser would.
const run = makeTestRun({ routes: AvatarRouteLive });

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
      // Variants are now proxy URLs (`/avatars/<token>`), not inline base64
      // data URLs (issue #289) — and each of the three points at a distinct
      // stored object.
      for (const src of Object.values(body.avatarVariants!)) {
        expect(src).toMatch(/^\/avatars\/[0-9a-f-]+$/);
      }
      expect(new Set(Object.values(body.avatarVariants!)).size).toBe(3);

      // Fetch the small variant back through the proxy route and confirm it
      // serves the actual resized WebP bytes with a long, immutable cache.
      const smallResponse = yield* Effect.promise(() =>
        handler(new Request(`http://localhost${body.avatarVariants!.small}`)),
      );
      expect(smallResponse.status).toBe(200);
      expect(smallResponse.headers.get("content-type")).toBe("image/webp");
      expect(smallResponse.headers.get("cache-control")).toContain("immutable");
      const smallBytes = new Uint8Array(
        yield* Effect.promise(() => smallResponse.arrayBuffer()),
      );
      const smallMeta = yield* Effect.promise(() =>
        sharp(smallBytes).metadata(),
      );
      expect(smallMeta.width).toBe(AVATAR_VARIANT_PX.small);
      expect(smallMeta.height).toBe(AVATAR_VARIANT_PX.small);

      const fetched = yield* authed.users.getUser({ params: { id: user.id } });
      expect(fetched.avatarUrl).toBeNull();
      expect(fetched.avatarVariants).toEqual(body.avatarVariants);
    }),
  ));

test("the avatar proxy route 404s for an unknown token", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        handler(new Request("http://localhost/avatars/does-not-exist-token")),
      );
      expect(response.status).toBe(404);
    }),
  ));

// Drives `POST /chats/:id/avatar` with a real multipart/form-data body —
// mirrors `uploadAvatarFile` above, just against the group-chat endpoint.
const uploadChatAvatarFile = async (
  handler: (request: Request) => Promise<Response>,
  token: string | null,
  chatId: number,
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
    new Request(`http://localhost/chats/${chatId}/avatar`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    }),
  );
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

test("uploadChatAvatar rejects an unauthenticated request", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "groupavatarer1",
        "pw-testpass",
      );
      const other = yield* registerAndLogin("groupavatarer1b", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const chat = yield* authed.chats.createGroupChat({
        payload: { title: "Group 1", participantIds: [other.user.id] },
      });

      const png = yield* Effect.promise(() =>
        makePng(MIN_AVATAR_SOURCE_PX, MIN_AVATAR_SOURCE_PX),
      );
      const result = yield* Effect.promise(() =>
        uploadChatAvatarFile(
          handler,
          null,
          chat.id,
          { filename: "avatar.png", contentType: "image/png", data: png },
          { x: 0, y: 0, size: MIN_AVATAR_SOURCE_PX },
        ),
      );
      expect(result.status).toBe(401);
    }),
  ));

test("uploadChatAvatar is forbidden for a member who isn't the owner or an admin", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const owner = yield* registerAndLogin("groupavatarer2", "pw-testpass");
      const member = yield* registerAndLogin("groupavatarer3", "pw-testpass");
      const ownerClient = yield* makeAuthedClient(owner.accessToken);
      const chat = yield* ownerClient.chats.createGroupChat({
        payload: { title: "Group 2", participantIds: [member.user.id] },
      });

      const png = yield* Effect.promise(() =>
        makePng(MIN_AVATAR_SOURCE_PX, MIN_AVATAR_SOURCE_PX),
      );
      const result = yield* Effect.promise(() =>
        uploadChatAvatarFile(
          handler,
          member.accessToken,
          chat.id,
          { filename: "avatar.png", contentType: "image/png", data: png },
          { x: 0, y: 0, size: MIN_AVATAR_SOURCE_PX },
        ),
      );
      expect(result.status).toBe(403);
      expect((result.body as { _tag: string })._tag).toBe("Forbidden");
    }),
  ));

test("uploadChatAvatar rejects uploading to a direct chat", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("groupavatarer4", "pw-testpass");
      const bob = yield* registerAndLogin("groupavatarer5", "pw-testpass");
      const aliceClient = yield* makeAuthedClient(alice.accessToken);
      const chat = yield* aliceClient.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const png = yield* Effect.promise(() =>
        makePng(MIN_AVATAR_SOURCE_PX, MIN_AVATAR_SOURCE_PX),
      );
      const result = yield* Effect.promise(() =>
        uploadChatAvatarFile(
          handler,
          alice.accessToken,
          chat.id,
          { filename: "avatar.png", contentType: "image/png", data: png },
          { x: 0, y: 0, size: MIN_AVATAR_SOURCE_PX },
        ),
      );
      expect(result.status).toBe(400);
      expect((result.body as { _tag: string })._tag).toBe("InvalidChatRequest");
    }),
  ));

test("uploadChatAvatar stores 3 fixed-size variants and is reflected by getChat and listChats", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const owner = yield* registerAndLogin("groupavatarer6", "pw-testpass");
      const other = yield* registerAndLogin("groupavatarer6b", "pw-testpass");
      const authed = yield* makeAuthedClient(owner.accessToken);
      const chat = yield* authed.chats.createGroupChat({
        payload: { title: "Group 6", participantIds: [other.user.id] },
      });
      expect(chat.avatarVariants).toBeNull();

      const size = 400;
      const png = yield* Effect.promise(() => makePng(size, size));
      const result = yield* Effect.promise(() =>
        uploadChatAvatarFile(
          handler,
          owner.accessToken,
          chat.id,
          { filename: "avatar.png", contentType: "image/png", data: png },
          { x: 0, y: 0, size },
        ),
      );
      expect(result.status).toBe(200);

      const body = result.body as {
        avatarVariants: { small: string; medium: string; large: string } | null;
      };
      expect(body.avatarVariants).not.toBeNull();
      for (const src of Object.values(body.avatarVariants!)) {
        expect(src).toMatch(/^\/avatars\/[0-9a-f-]+$/);
      }
      expect(new Set(Object.values(body.avatarVariants!)).size).toBe(3);

      const smallResponse = yield* Effect.promise(() =>
        handler(new Request(`http://localhost${body.avatarVariants!.small}`)),
      );
      expect(smallResponse.status).toBe(200);
      expect(smallResponse.headers.get("content-type")).toBe("image/webp");

      const fetched = yield* authed.chats.getChat({ params: { id: chat.id } });
      expect(fetched.avatarVariants).toEqual(body.avatarVariants);

      const listed = yield* authed.chats.listChats({ query: {} });
      const listedChat = listed.chats.find((c) => c.id === chat.id);
      expect(listedChat?.avatarVariants).toEqual(body.avatarVariants);
    }),
  ));

test("deleteChatAvatar clears an uploaded group avatar and is forbidden for a plain member", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const owner = yield* registerAndLogin("groupavatarer7", "pw-testpass");
      const member = yield* registerAndLogin("groupavatarer8", "pw-testpass");
      const ownerClient = yield* makeAuthedClient(owner.accessToken);
      const memberClient = yield* makeAuthedClient(member.accessToken);
      const chat = yield* ownerClient.chats.createGroupChat({
        payload: { title: "Group 7", participantIds: [member.user.id] },
      });

      const size = MIN_AVATAR_SOURCE_PX;
      const png = yield* Effect.promise(() => makePng(size, size));
      yield* Effect.promise(() =>
        uploadChatAvatarFile(
          handler,
          owner.accessToken,
          chat.id,
          { filename: "avatar.png", contentType: "image/png", data: png },
          { x: 0, y: 0, size },
        ),
      );

      const forbidden = yield* memberClient.chats
        .deleteChatAvatar({ params: { id: chat.id } })
        .pipe(Effect.result);
      expect(forbidden._tag).toBe("Failure");
      if (forbidden._tag === "Failure") {
        expect((forbidden.failure as { _tag: string })._tag).toBe("Forbidden");
      }

      const cleared = yield* ownerClient.chats.deleteChatAvatar({
        params: { id: chat.id },
      });
      expect(cleared.avatarVariants).toBeNull();
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
