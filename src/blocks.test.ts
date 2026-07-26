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
import { ChatApi } from "./Api.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { AttachmentsHandlerLive } from "./AttachmentsHandler.ts";
import { AttachmentStorageLive } from "./AttachmentStorage.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { SearchHandlerLive } from "./SearchHandler.ts";
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

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(EngagementHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(SearchHandlerLive),
  Layer.provide(AttachmentsHandlerLive),
  Layer.provide(AttachmentStorageLive),
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
);

const { getTestDb } = makeTestDbAccessor();

const run = async <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Db>,
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
      effect.pipe(Effect.provide(TestClientLayer), Effect.provide(TestDbLive)),
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
    return { user, accessToken, client: yield* makeAuthedClient(accessToken) };
  });

const PW = "pw-testpass";

test("setBlock records a block and listBlocks returns it", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      const entry = yield* alice.client.users.setBlock({
        path: { id: bob.user.id },
        payload: { type: "block" },
      });
      expect(entry.type).toBe("block");
      expect(entry.user.id).toBe(bob.user.id);

      const blocks = yield* alice.client.users.listBlocks();
      expect(blocks.length).toBe(1);
      expect(blocks[0]?.user.id).toBe(bob.user.id);
      expect(blocks[0]?.type).toBe("block");
    }),
  ));

test("setBlock upgrades a mute to a block in place (no duplicate row)", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      yield* alice.client.users.setBlock({
        path: { id: bob.user.id },
        payload: { type: "mute" },
      });
      const upgraded = yield* alice.client.users.setBlock({
        path: { id: bob.user.id },
        payload: { type: "block" },
      });
      expect(upgraded.type).toBe("block");

      const blocks = yield* alice.client.users.listBlocks();
      expect(blocks.length).toBe(1);
      expect(blocks[0]?.type).toBe("block");
    }),
  ));

test("removeBlock lifts the relationship and is idempotent", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      yield* alice.client.users.setBlock({
        path: { id: bob.user.id },
        payload: { type: "block" },
      });
      yield* alice.client.users.removeBlock({ path: { id: bob.user.id } });
      expect((yield* alice.client.users.listBlocks()).length).toBe(0);

      // Removing again succeeds (no relationship to remove).
      yield* alice.client.users.removeBlock({ path: { id: bob.user.id } });
      expect((yield* alice.client.users.listBlocks()).length).toBe(0);
    }),
  ));

test("setBlock rejects blocking yourself", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const result = yield* alice.client.users
        .setBlock({
          path: { id: alice.user.id },
          payload: { type: "block" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidBlockRequest",
        );
      }
    }),
  ));

test("setBlock 404s for a non-existent target", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const result = yield* alice.client.users
        .setBlock({ path: { id: 999999 }, payload: { type: "block" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));

test("listBlocks requires authentication", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users.listBlocks().pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("listPosts hides posts from blocked and muted authors, restored on removeBlock", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);
      const carol = yield* registerAndLogin("carol", PW);

      yield* bob.client.posts.createPost({
        payload: { contentType: "text", content: "bob post" },
      });
      yield* carol.client.posts.createPost({
        payload: { contentType: "text", content: "carol post" },
      });
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "alice post" },
      });

      // Alice blocks bob and mutes carol — both authors drop out of her feed.
      yield* alice.client.users.setBlock({
        path: { id: bob.user.id },
        payload: { type: "block" },
      });
      yield* alice.client.users.setBlock({
        path: { id: carol.user.id },
        payload: { type: "mute" },
      });

      const filtered = yield* alice.client.posts.listPosts({ urlParams: {} });
      expect(filtered.posts.map((p) => p.authorId)).toEqual([alice.user.id]);

      // Bob still sees everyone's posts — the filter is per-viewer.
      const bobFeed = yield* bob.client.posts.listPosts({ urlParams: {} });
      expect(bobFeed.posts.length).toBe(3);

      // Unblocking bob brings his post back into alice's feed.
      yield* alice.client.users.removeBlock({ path: { id: bob.user.id } });
      const afterUnblock = yield* alice.client.posts.listPosts({
        urlParams: {},
      });
      expect(afterUnblock.posts.map((p) => p.authorId).sort()).toEqual(
        [alice.user.id, bob.user.id].sort(),
      );
    }),
  ));

test("createMessage is rejected in a direct chat when either party has blocked the other", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      // Bob blocks alice; now neither can message in the direct chat.
      yield* bob.client.users.setBlock({
        path: { id: alice.user.id },
        payload: { type: "block" },
      });

      const aliceSend = yield* alice.client.chats
        .createMessage({
          path: { id: chat.id },
          payload: { contentType: "text", content: "hi bob" },
        })
        .pipe(Effect.either);
      expect(aliceSend._tag).toBe("Left");
      if (aliceSend._tag === "Left") {
        expect((aliceSend.left as { _tag: string })._tag).toBe("Forbidden");
      }

      const bobSend = yield* bob.client.chats
        .createMessage({
          path: { id: chat.id },
          payload: { contentType: "text", content: "hi alice" },
        })
        .pipe(Effect.either);
      expect(bobSend._tag).toBe("Left");

      // After bob unblocks, messaging works again.
      yield* bob.client.users.removeBlock({ path: { id: alice.user.id } });
      const ok = yield* alice.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "hi again" },
      });
      expect(ok.content).toBe("hi again");
    }),
  ));

test("a mute does not block direct messaging", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      yield* bob.client.users.setBlock({
        path: { id: alice.user.id },
        payload: { type: "mute" },
      });

      // Muting only suppresses notifications — alice can still send.
      const sent = yield* alice.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "still delivered" },
      });
      expect(sent.content).toBe("still delivered");
    }),
  ));

test("createMessage succeeds in a group chat where a participant muted the sender", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);
      const carol = yield* registerAndLogin("carol", PW);

      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      // Carol mutes alice — alice's group messages still post (the mute only
      // suppresses carol's realtime notification, exercised in dispatch).
      yield* carol.client.users.setBlock({
        path: { id: alice.user.id },
        payload: { type: "mute" },
      });

      const sent = yield* alice.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "hello group" },
      });
      expect(sent.content).toBe("hello group");
    }),
  ));
