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
import { buildSnippet } from "./search.ts";
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

// The runs a snippet marked as matched, lower-cased — what the highlighter
// actually put a `<mark>` around.
const matchedText = (
  snippet: ReadonlyArray<{ text: string; match: boolean }>,
): string[] => snippet.filter((s) => s.match).map((s) => s.text.toLowerCase());

// ---------------------------------------------------------------------------
// Snippet building (pure — no database)
// ---------------------------------------------------------------------------

test("buildSnippet highlights every occurrence of the query", () => {
  const snippet = buildSnippet("a fox, another fox", "fox");
  expect(matchedText(snippet)).toEqual(["fox", "fox"]);
  expect(snippetText(snippet)).toBe("a fox, another fox");
});

test("buildSnippet highlights a fragment inside a word", () => {
  const snippet = buildSnippet("a fragmentary thought", "ragmen");
  expect(matchedText(snippet)).toEqual(["ragmen"]);
  // The rest of the word is still there, just unhighlighted.
  expect(snippetText(snippet)).toBe("a fragmentary thought");
});

test("buildSnippet windows a long document around the first match", () => {
  const content = `${"filler word ".repeat(60)}needle${" trailing word".repeat(60)}`;
  const snippet = buildSnippet(content, "needle");
  const text = snippetText(snippet);
  expect(matchedText(snippet)).toEqual(["needle"]);
  expect(text).toContain("needle");
  // Windowed, not the whole document, and elided on both sides.
  expect(text.length).toBeLessThan(content.length);
  expect(text.startsWith("…")).toBe(true);
  expect(text.endsWith("…")).toBe(true);
});

test("buildSnippet falls back to a leading excerpt when nothing matches literally", () => {
  // A stemmed-only match: the row matched "running" via the english stemmer,
  // but the raw text holds no "ran".
  const snippet = buildSnippet("I love running every day", "ran");
  expect(matchedText(snippet)).toEqual([]);
  expect(snippetText(snippet)).toBe("I love running every day");
});

test("buildSnippet never emits empty runs", () => {
  const snippet = buildSnippet("fox", "fox");
  expect(snippet.every((s) => s.text.length > 0)).toBe(true);
});

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

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
      expect(matchedText(result.snippet)).toContain("fox");
      expect(snippetText(result.snippet)).toContain("The quick brown fox");
      // The author is joined into the result — no follow-up request needed to
      // render the row.
      expect(result.author.id).toBe(alice.user.id);
      expect(result.author.username).toBe("alice");
    }),
  ));

test("searchPosts matches a fragment inside a word (contains, not whole-word)", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "a fragmentary thought" },
      });
      // "ragmen" is a whole word nowhere — only the trigram/substring branch
      // can find it.
      const page = yield* alice.client.search.searchPosts({
        urlParams: { q: "ragmen" },
      });
      expect(page.results.length).toBe(1);
      expect(matchedText(page.results[0]!.snippet)).toContain("ragmen");
    }),
  ));

test("searchPosts matches a half-typed word as a prefix", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "deployment notes for today" },
      });
      const page = yield* alice.client.search.searchPosts({
        urlParams: { q: "depl" },
      });
      expect(page.results.length).toBe(1);
    }),
  ));

test("searchPosts requires every token of a multi-word query to match", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "the quick brown fox" },
      });
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "a quick note" },
      });
      const page = yield* alice.client.search.searchPosts({
        urlParams: { q: "quick fox" },
      });
      expect(page.results.length).toBe(1);
      expect(snippetText(page.results[0]!.snippet)).toContain("brown fox");
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
      expect(snippetText(page.results[0]!.snippet)).toContain("running");
    }),
  ));

test("searchPosts ignores non-text posts (image URLs aren't searched)", () =>
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

test("searchPosts hides posts by a blocked or muted author", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      yield* bob.client.posts.createPost({
        payload: { contentType: "text", content: "a pineapple announcement" },
      });

      const before = yield* alice.client.search.searchPosts({
        urlParams: { q: "pineapple" },
      });
      expect(before.results.length).toBe(1);

      yield* alice.client.users.setBlock({
        path: { id: bob.user.id },
        payload: { type: "block" },
      });

      const after = yield* alice.client.search.searchPosts({
        urlParams: { q: "pineapple" },
      });
      expect(after.results.length).toBe(0);
    }),
  ));

test("searchPosts does not interpret query text as SQL or tsquery operators", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "harmless content here" },
      });
      // A malformed tsquery / injection attempt must not error — the
      // tokenizer strips every operator, so it just finds nothing.
      const page = yield* alice.client.search.searchPosts({
        urlParams: { q: `') ; drop table posts; --  "(&^ -unbalanced` },
      });
      expect(page.results.length).toBe(0);
      // …and the table is still there.
      const still = yield* alice.client.search.searchPosts({
        urlParams: { q: "harmless" },
      });
      expect(still.results.length).toBe(1);
    }),
  ));

test("searchPosts tokenizes away wildcards instead of matching everything", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "alphabet soup" },
      });
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "beta release" },
      });
      // "%" is not a token character, so it never reaches a LIKE pattern —
      // this searches for "alp" and "abet", not for "anything".
      const page = yield* alice.client.search.searchPosts({
        urlParams: { q: "alp%abet" },
      });
      expect(page.results.length).toBe(1);
      expect(snippetText(page.results[0]!.snippet)).toContain("alphabet");
    }),
  ));

test("users.searchUsers matches wildcards literally, not as patterns", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* registerAndLogin("bob", "pw-testpass");
      // The directory search passes `q` through as an ILIKE pattern, so its
      // wildcards must be escaped: "%a%" must find nobody, not everybody.
      const escaped = yield* alice.client.users.searchUsers({
        urlParams: { q: "%a%" },
      });
      expect(escaped.length).toBe(0);
      const real = yield* alice.client.users.searchUsers({
        urlParams: { q: "ali" },
      });
      expect(real.map((u) => u.username)).toEqual(["alice"]);
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
      // execute.
      const result = page.results[0]!;
      expect(result.snippet.every((s) => typeof s.text === "string")).toBe(
        true,
      );
      expect(matchedText(result.snippet)).toContain("danger");
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
      expect(first.results.map((r) => r.id)).toEqual([
        created[2]!,
        created[1]!,
      ]);
      expect(first.nextCursor).not.toBeNull();

      const second = yield* alice.client.search.searchPosts({
        urlParams: { q: "apple", limit: 2, cursor: first.nextCursor! },
      });
      expect(second.results.map((r) => r.id)).toEqual([created[0]!]);
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

// ---------------------------------------------------------------------------
// Comments and replies
// ---------------------------------------------------------------------------

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
      expect(page.results[0]!.postId).toBe(post.id);
      expect(page.results[0]!.parentCommentId).toBeNull();
      expect(page.results[0]!.author.username).toBe("alice");
      expect(snippetText(page.results[0]!.snippet)).toContain("pineapple");
    }),
  ));

test("searchComments finds a matching reply and flags its parent", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "a post to comment on" },
      });
      const comment = yield* alice.client.comments.createComment({
        path: { id: post.id },
        payload: { content: "top level" },
      });
      yield* alice.client.comments.createReply({
        path: { id: comment.id },
        payload: { content: "replying about kumquats" },
      });

      // A fragment, again — "umquat" is a whole word nowhere.
      const page = yield* alice.client.search.searchComments({
        urlParams: { q: "umquat" },
      });
      expect(page.results.length).toBe(1);
      expect(page.results[0]!.parentCommentId).toBe(comment.id);
      expect(page.results[0]!.postId).toBe(post.id);
    }),
  ));

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

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
      expect(page.results[0]!.chatId).toBe(aliceBob.id);
      expect(page.results[0]!.sender.id).toBe(alice.user.id);

      // The chat context is returned with participants so the UI can render
      // the chat's name/avatar.
      const ctx = page.chats.find((c) => c.id === aliceBob.id);
      expect(ctx).toBeDefined();
      expect(ctx!.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, bob.user.id].sort(),
      );
    }),
  ));

test("searchMessages finds a fragment inside a word", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      yield* bob.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "see you at the airport" },
      });
      const page = yield* alice.client.search.searchMessages({
        urlParams: { q: "irpor" },
      });
      expect(page.results.length).toBe(1);
      expect(page.results[0]!.sender.id).toBe(bob.user.id);
      expect(matchedText(page.results[0]!.snippet)).toContain("irpor");
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

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

test("searchUsers matches a fragment of a username or display name", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* registerAndLogin("bobby", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      yield* carol.client.users.updateProfile({
        payload: { displayName: "Caroline Fitzgerald", avatarUrl: null },
      });

      // Mid-word fragment of a username.
      const byUsername = yield* alice.client.search.searchUsers({
        urlParams: { q: "obb" },
      });
      expect(byUsername.results.map((r) => r.user.username)).toEqual(["bobby"]);

      // Mid-word fragment of a display name, highlighted in that name.
      const byDisplayName = yield* alice.client.search.searchUsers({
        urlParams: { q: "zgeral" },
      });
      expect(byDisplayName.results.map((r) => r.user.username)).toEqual([
        "carol",
      ]);
      expect(snippetText(byDisplayName.results[0]!.snippet)).toContain(
        "Fitzgerald",
      );
      expect(matchedText(byDisplayName.results[0]!.snippet)).toContain(
        "zgeral",
      );
    }),
  ));

test("searchUsers ranks an exact username, then a prefix, then a fragment", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* registerAndLogin("zoemander", "pw-testpass"); // contains "man"
      yield* registerAndLogin("mandy", "pw-testpass"); // starts with "man"
      yield* registerAndLogin("man", "pw-testpass"); // exact

      const page = yield* alice.client.search.searchUsers({
        urlParams: { q: "man" },
      });
      expect(page.results.map((r) => r.user.username)).toEqual([
        "man",
        "mandy",
        "zoemander",
      ]);
    }),
  ));

test("searchUsers paginates with an opaque cursor", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      for (const name of ["searcher1", "searcher2", "searcher3"])
        yield* registerAndLogin(name, "pw-testpass");

      const first = yield* alice.client.search.searchUsers({
        urlParams: { q: "searcher", limit: 2 },
      });
      expect(first.results.map((r) => r.user.username)).toEqual([
        "searcher1",
        "searcher2",
      ]);
      expect(first.nextCursor).not.toBeNull();

      const second = yield* alice.client.search.searchUsers({
        urlParams: { q: "searcher", limit: 2, cursor: first.nextCursor! },
      });
      expect(second.results.map((r) => r.user.username)).toEqual(["searcher3"]);
      expect(second.nextCursor).toBeNull();
    }),
  ));

test("searchUsers keeps the directory's narrowness floor for non-admins", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* registerAndLogin("bo", "pw-testpass");

      // Two characters is enough to search *content* but not to browse
      // people (issue #48) — the section comes back empty rather than
      // failing, so the rest of a two-character search still answers.
      const page = yield* alice.client.search.searchUsers({
        urlParams: { q: "bo" },
      });
      expect(page.results.length).toBe(0);
      expect(page.nextCursor).toBeNull();

      const all = yield* alice.client.search.searchAll({
        urlParams: { q: "bo" },
      });
      expect(all.users.results.length).toBe(0);

      // Three characters searches people as usual.
      const wide = yield* alice.client.search.searchUsers({
        urlParams: { q: "ali" },
      });
      expect(wide.results.map((r) => r.user.username)).toEqual(["alice"]);
    }),
  ));

test("searchUsers rejects a malformed cursor", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const result = yield* alice.client.search
        .searchUsers({ urlParams: { q: "alice", cursor: "not-a-cursor" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidSearchRequest",
        );
    }),
  ));

// ---------------------------------------------------------------------------
// Unified search
// ---------------------------------------------------------------------------

test("searchAll returns people, posts, comments and messages in one request", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("kumquatfan", "pw-testpass");

      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "kumquat harvest is early" },
      });
      yield* alice.client.comments.createComment({
        path: { id: post.id },
        payload: { content: "my favourite kumquat variety" },
      });
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      yield* alice.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "bringing kumquats tonight" },
      });

      const page = yield* alice.client.search.searchAll({
        urlParams: { q: "kumquat" },
      });
      expect(page.users.results.map((r) => r.user.username)).toEqual([
        "kumquatfan",
      ]);
      expect(page.posts.results.map((r) => r.id)).toEqual([post.id]);
      expect(page.comments.results.length).toBe(1);
      expect(page.messages.results.length).toBe(1);
      expect(page.messages.chats.map((c) => c.id)).toEqual([chat.id]);
    }),
  ));

test("searchAll previews each section and hands over a cursor to continue", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const created: number[] = [];
      for (let i = 0; i < 4; i++) {
        const post = yield* alice.client.posts.createPost({
          payload: { contentType: "text", content: `apricot number ${i}` },
        });
        created.push(post.id);
      }

      const all = yield* alice.client.search.searchAll({
        urlParams: { q: "apricot", limit: 2 },
      });
      expect(all.posts.results.map((r) => r.id)).toEqual([
        created[3]!,
        created[2]!,
      ]);
      expect(all.posts.nextCursor).not.toBeNull();

      // The per-type endpoint resumes exactly where the preview stopped.
      const rest = yield* alice.client.search.searchPosts({
        urlParams: { q: "apricot", cursor: all.posts.nextCursor! },
      });
      expect(rest.results.map((r) => r.id)).toEqual([created[1]!, created[0]!]);
    }),
  ));

test("searchAll scopes messages to the caller and hides blocked authors", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");

      yield* bob.client.posts.createPost({
        payload: { contentType: "text", content: "blocked tangerine post" },
      });
      const bobCarol = yield* bob.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      yield* bob.client.chats.createMessage({
        path: { id: bobCarol.id },
        payload: { contentType: "text", content: "private tangerine chatter" },
      });
      yield* alice.client.users.setBlock({
        path: { id: bob.user.id },
        payload: { type: "block" },
      });

      const page = yield* alice.client.search.searchAll({
        urlParams: { q: "tangerine" },
      });
      expect(page.posts.results.length).toBe(0);
      expect(page.messages.results.length).toBe(0);
    }),
  ));

test("searchAll rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.search
        .searchAll({ urlParams: { q: "hello" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
    }),
  ));
