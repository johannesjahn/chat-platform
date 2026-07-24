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
import { AttachmentsHandlerLive } from "./AttachmentsHandler.ts";
import { AttachmentStorageLive } from "./AttachmentStorage.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
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

// Reassembles the highlighted snippet back into plain text, so a test can
// assert what matched without caring how it was split into runs.
const snippetText = (
  snippet: ReadonlyArray<{ text: string; match: boolean }>,
): string => snippet.map((s) => s.text).join("");

test("searchPosts rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.search
        .searchPosts({ urlParams: { q: "hello" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
    }),
  ));

test("searchPosts finds a matching text post and highlights the match", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "The quick brown fox jumps" },
      });
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "A totally unrelated note" },
      });

      const page = yield* alice.client.search.searchPosts({
        urlParams: { q: "fox" },
      });
      expect(page.results.length).toBe(1);
      const result = page.results[0]!;
      expect(result.post.content).toBe("The quick brown fox jumps");
      // At least one run is a highlighted match, and it covers "fox".
      const matched = result.snippet.filter((s) => s.match);
      expect(matched.length).toBeGreaterThan(0);
      expect(matched.map((s) => s.text.toLowerCase())).toContain("fox");
      expect(snippetText(result.snippet)).toContain("fox");
    }),
  ));

test("searchPosts matches stemmed terms (english config)", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "I love running every day" },
      });
      // "run" should match "running" once both are stemmed.
      const page = yield* alice.client.search.searchPosts({
        urlParams: { q: "run" },
      });
      expect(page.results.length).toBe(1);
      expect(page.results[0]!.post.content).toContain("running");
    }),
  ));

test("searchPosts ignores non-text posts (image URLs aren't indexed)", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* alice.client.posts.createPost({
        payload: {
          contentType: "image_url",
          content: "https://imgur.com/quickfox.png",
        },
      });
      const page = yield* alice.client.search.searchPosts({
        urlParams: { q: "quickfox" },
      });
      expect(page.results.length).toBe(0);
    }),
  ));

test("searchPosts does not interpret query text as SQL or tsquery operators", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "harmless content here" },
      });
      // A malformed tsquery / injection attempt must not error — it just
      // finds nothing.
      const page = yield* alice.client.search.searchPosts({
        urlParams: { q: `') ; drop table posts; --  "(&^ -unbalanced` },
      });
      expect(page.results.length).toBe(0);
    }),
  ));

test("searchPosts snippet keeps HTML-like content inert (no raw markup)", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const content = "beware the <script>alert(1)</script> danger";
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content },
      });
      const page = yield* alice.client.search.searchPosts({
        urlParams: { q: "danger" },
      });
      expect(page.results.length).toBe(1);
      // The snippet is delivered as structured plain-text runs, never HTML:
      // the frontend renders each run as escaped React text, so markup can't
      // execute. `ts_headline` additionally strips tags server-side, so the
      // rendered excerpt is inert text either way — the match is still found
      // and highlighted.
      const result = page.results[0]!;
      expect(result.snippet.every((s) => typeof s.text === "string")).toBe(
        true,
      );
      expect(result.snippet.some((s) => s.match)).toBe(true);
      expect(snippetText(result.snippet).toLowerCase()).toContain("danger");
      // The full, unmodified content is always available separately for the
      // client to render safely (escaped) if it wants more than the excerpt.
      expect(result.post.content).toBe(content);
    }),
  ));

test("searchPosts paginates newest-match-first with an opaque cursor", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const created: number[] = [];
      for (let i = 0; i < 3; i++) {
        const post = yield* alice.client.posts.createPost({
          payload: { contentType: "text", content: `apple number ${i}` },
        });
        created.push(post.id);
      }

      const first = yield* alice.client.search.searchPosts({
        urlParams: { q: "apple", limit: 2 },
      });
      expect(first.results.map((r) => r.post.id)).toEqual([
        created[2]!,
        created[1]!,
      ]);
      expect(first.nextCursor).not.toBeNull();

      const second = yield* alice.client.search.searchPosts({
        urlParams: { q: "apple", limit: 2, cursor: first.nextCursor! },
      });
      expect(second.results.map((r) => r.post.id)).toEqual([created[0]!]);
      expect(second.nextCursor).toBeNull();
    }),
  ));

test("searchPosts rejects a malformed cursor", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const result = yield* alice.client.search
        .searchPosts({ urlParams: { q: "apple", cursor: "!!!not-base64!!!" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidSearchRequest",
        );
    }),
  ));

test("searchComments finds a matching comment", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "a post to comment on" },
      });
      yield* alice.client.comments.createComment({
        path: { id: post.id },
        payload: { content: "what a wonderful pineapple observation" },
      });
      const page = yield* alice.client.search.searchComments({
        urlParams: { q: "pineapple" },
      });
      expect(page.results.length).toBe(1);
      expect(page.results[0]!.comment.postId).toBe(post.id);
      expect(snippetText(page.results[0]!.snippet)).toContain("pineapple");
    }),
  ));

test("searchMessages only returns messages from the caller's own chats", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");

      // Alice <-> Bob chat with a matching message.
      const aliceBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      yield* alice.client.chats.createMessage({
        path: { id: aliceBob.id },
        payload: { contentType: "text", content: "let's meet at the harbor" },
      });

      // Bob <-> Carol chat (Alice is NOT a participant) with the same term.
      const bobCarol = yield* bob.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      yield* bob.client.chats.createMessage({
        path: { id: bobCarol.id },
        payload: { contentType: "text", content: "secret harbor plans" },
      });

      const page = yield* alice.client.search.searchMessages({
        urlParams: { q: "harbor" },
      });
      // Alice sees only her own chat's message, never Bob<->Carol's.
      expect(page.results.length).toBe(1);
      expect(page.results[0]!.message.chatId).toBe(aliceBob.id);
      expect(page.results.every((r) => r.message.chatId !== bobCarol.id)).toBe(
        true,
      );

      // The chat context is returned with participants so the UI can render
      // the chat's name/avatar.
      const ctx = page.chats.find((c) => c.id === aliceBob.id);
      expect(ctx).toBeDefined();
      expect(ctx!.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, bob.user.id].sort(),
      );
    }),
  ));

test("searchMessages finds nothing for a term only in someone else's chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const bobCarol = yield* bob.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      yield* bob.client.chats.createMessage({
        path: { id: bobCarol.id },
        payload: { contentType: "text", content: "confidential zebra intel" },
      });
      const page = yield* alice.client.search.searchMessages({
        urlParams: { q: "zebra" },
      });
      expect(page.results.length).toBe(0);
      expect(page.chats.length).toBe(0);
    }),
  ));
