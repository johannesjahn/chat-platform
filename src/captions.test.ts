import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect } from "effect";
import sharp from "sharp";
import { type Attachment, ChatApi } from "./Api.ts";
import { Db } from "./Db.ts";
import { messages, posts } from "./db/schema.ts";
import { makeTestRun } from "./testApi.ts";

// Captions on attachments (issue #765): `caption` beside `attachmentId` on
// posts and chat messages, while `content` keeps the filename.

const run = makeTestRun();

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

const registerAndLogin = (username: string) =>
  Effect.gen(function* () {
    const password = "pw-testpass";
    const c = yield* makeClient;
    const user = yield* c.users.register({ payload: { username, password } });
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return { user, accessToken, client: yield* makeAuthedClient(accessToken) };
  });

type Handler = (request: Request) => Promise<Response>;

const uploadPng = (handler: Handler, token: string) =>
  Effect.promise(async () => {
    const png = await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 3,
        background: { r: 30, g: 140, b: 90 },
      },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "bread.png");
    const response = await handler(
      new Request("http://localhost/attachments", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }),
    );
    expect(response.status).toBe(201);
    return (await response.json()) as Attachment;
  });

const rawJson = (
  handler: Handler,
  token: string,
  method: string,
  path: string,
  body: unknown,
) =>
  Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    ),
  );

test("a post can carry a caption beside its attachment, and content keeps the filename", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const upload = yield* uploadPng(handler, alice.accessToken);
      const created = yield* alice.client.posts.createPost({
        payload: {
          contentType: "attachment",
          content: "bread.png",
          attachmentId: upload.id,
          caption: "Look what I baked https://example.com",
        },
      });
      expect(created.caption).toBe("Look what I baked https://example.com");
      expect(created.content).toBe("bread.png");
      expect(created.attachment!.id).toBe(upload.id);

      const fetched = yield* alice.client.posts.getPost({
        params: { id: created.id },
      });
      expect(fetched.caption).toBe("Look what I baked https://example.com");
      const feed = yield* alice.client.posts.listPosts({ query: {} });
      expect(feed.posts[0]!.caption).toBe(
        "Look what I baked https://example.com",
      );

      // An edit that omits the caption (a client that predates it) keeps it…
      const kept = yield* alice.client.posts.updatePost({
        params: { id: created.id },
        payload: {
          contentType: "attachment",
          content: "bread.png",
          attachmentId: upload.id,
        },
      });
      expect(kept.caption).toBe("Look what I baked https://example.com");
      // …a new one replaces it, null clears it…
      const changed = yield* alice.client.posts.updatePost({
        params: { id: created.id },
        payload: {
          contentType: "attachment",
          content: "bread.png",
          attachmentId: upload.id,
          caption: "Sourdough, day 3",
        },
      });
      expect(changed.caption).toBe("Sourdough, day 3");
      const cleared = yield* alice.client.posts.updatePost({
        params: { id: created.id },
        payload: {
          contentType: "attachment",
          content: "bread.png",
          attachmentId: upload.id,
          caption: null,
        },
      });
      expect(cleared.caption).toBeNull();
      // …and an attachment without one reads as null.
      const plain = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "just text" },
      });
      expect(plain.caption).toBeNull();
    }),
  ));

test("a caption is rejected on anything but an attachment", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const response = yield* rawJson(
        handler,
        alice.accessToken,
        "POST",
        "/posts",
        { contentType: "text", content: "hello", caption: "nope" },
      );
      expect(response.status).toBe(400);
      const body = (yield* Effect.promise(() => response.json())) as {
        message: string;
      };
      expect(body.message).toBe(
        `caption may only be set when contentType is "attachment"`,
      );

      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const messageResponse = yield* rawJson(
        handler,
        alice.accessToken,
        "POST",
        `/chats/${chat.id}/messages`,
        { contentType: "text", content: "hello", caption: "nope" },
      );
      expect(messageResponse.status).toBe(400);
    }),
  ));

test("an old attachment row, with only a filename, still reads as it did", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const alice = yield* registerAndLogin("alice");
      const upload = yield* uploadPng(handler, alice.accessToken);
      // What a replica that predates captions writes: no caption at all.
      const [row] = yield* Effect.promise(() =>
        db
          .insert(posts)
          .values({
            authorId: alice.user.id,
            contentType: "attachment",
            content: "bread.png",
            attachmentId: upload.id,
          })
          .returning(),
      );
      const fetched = yield* alice.client.posts.getPost({
        params: { id: row!.id },
      });
      expect(fetched.content).toBe("bread.png");
      expect(fetched.caption).toBeNull();
      expect(fetched.attachment!.filename).toBe("bread.png");

      // A leftover caption on a row an old replica turned into a text post
      // never shows.
      yield* Effect.promise(() =>
        db
          .update(posts)
          .set({ contentType: "text", content: "now text", caption: "stale" })
          .where(eq(posts.id, row!.id)),
      );
      const edited = yield* alice.client.posts.getPost({
        params: { id: row!.id },
      });
      expect(edited.caption).toBeNull();
    }),
  ));

test("an @mention in a caption notifies, and its excerpt is the caption", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      const upload = yield* uploadPng(handler, alice.accessToken);
      const post = yield* alice.client.posts.createPost({
        payload: {
          contentType: "attachment",
          content: "bread.png",
          attachmentId: upload.id,
          caption: "baked this with @bob",
        },
      });
      const inbox = yield* bob.client.notifications.listNotifications({
        query: {},
      });
      expect(inbox.notifications.map((n) => n.type)).toEqual(["mention"]);
      expect(inbox.notifications[0]!.postId).toBe(post.id);
      expect(inbox.notifications[0]!.excerpt).toBe("baked this with @bob");

      // An edit only pings names it added.
      yield* alice.client.posts.updatePost({
        params: { id: post.id },
        payload: {
          contentType: "attachment",
          content: "bread.png",
          attachmentId: upload.id,
          caption: "baked this with @bob and @carol",
        },
      });
      expect(
        (yield* bob.client.notifications.listNotifications({ query: {} }))
          .notifications.length,
      ).toBe(1);
      expect(
        (yield* carol.client.notifications.listNotifications({ query: {} }))
          .notifications.map((n) => n.type),
      ).toEqual(["mention"]);
    }),
  ));

test("search finds a caption, but never an attachment's filename", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const postUpload = yield* uploadPng(handler, alice.accessToken);
      const post = yield* alice.client.posts.createPost({
        payload: {
          contentType: "attachment",
          content: "zebrafile.png",
          attachmentId: postUpload.id,
          caption: "Freshly baked sourdough",
        },
      });
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const messageUpload = yield* uploadPng(handler, alice.accessToken);
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          contentType: "attachment",
          content: "zebrafile.png",
          attachmentId: messageUpload.id,
          caption: "Harbor at dusk",
        },
      });

      // The word/prefix branch (stemmed: "bake" finds "baked")…
      const byWord = yield* bob.client.search.searchPosts({
        query: { q: "bake" },
      });
      expect(byWord.results.map((r) => r.id)).toEqual([post.id]);
      expect(byWord.results[0]!.snippet.map((s) => s.text).join("")).toBe(
        "Freshly baked sourdough",
      );
      // …and the substring branch.
      const byFragment = yield* bob.client.search.searchPosts({
        query: { q: "ourdou" },
      });
      expect(byFragment.results.map((r) => r.id)).toEqual([post.id]);

      const messageHits = yield* bob.client.search.searchMessages({
        query: { q: "harbor" },
      });
      expect(messageHits.results.map((r) => r.id)).toEqual([message.id]);
      const messageFragment = yield* bob.client.search.searchMessages({
        query: { q: "arbo" },
      });
      expect(messageFragment.results.map((r) => r.id)).toEqual([message.id]);

      // The filename is no more searchable than it ever was.
      expect(
        (yield* bob.client.search.searchPosts({ query: { q: "zebrafile" } }))
          .results,
      ).toEqual([]);
      expect(
        (yield* bob.client.search.searchMessages({ query: { q: "zebrafile" } }))
          .results,
      ).toEqual([]);
    }),
  ));

test("a chat message carries a caption through replies and forwards", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      const aliceBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const bobCarol = yield* bob.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const upload = yield* uploadPng(handler, alice.accessToken);
      const original = yield* alice.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: {
          contentType: "attachment",
          content: "bread.png",
          attachmentId: upload.id,
          caption: "Look what I baked",
        },
      });
      expect(original.caption).toBe("Look what I baked");
      expect(original.content).toBe("bread.png");

      const listed = yield* bob.client.chats.listMessages({
        params: { id: aliceBob.id },
        query: {},
      });
      expect(listed.messages.find((m) => m.id === original.id)!.caption).toBe(
        "Look what I baked",
      );

      // A reply's quote shows the caption, not only "Attachment".
      const reply = yield* bob.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: {
          contentType: "text",
          content: "yum",
          parentMessageId: original.id,
        },
      });
      expect(reply.parentMessage).toMatchObject({
        contentType: "attachment",
        caption: "Look what I baked",
      });

      // A forward copies the caption with its attachment.
      const { results } = yield* bob.client.chats.forwardMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: { targetChatIds: [bobCarol.id] },
      });
      const copy = results[0]!.message!;
      expect(copy.caption).toBe("Look what I baked");
      expect(copy.content).toBe("bread.png");
      expect(copy.attachment!.id).not.toBe(upload.id);
      const [copyRow] = yield* Effect.promise(() =>
        db.select().from(messages).where(eq(messages.id, copy.id)),
      );
      expect(copyRow!.caption).toBe("Look what I baked");

      // Editing the caption, keeping it, and clearing it.
      const edited = yield* alice.client.chats.updateMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: {
          contentType: "attachment",
          content: "bread.png",
          attachmentId: upload.id,
          caption: "Baked, then eaten",
        },
      });
      expect(edited.caption).toBe("Baked, then eaten");
      const kept = yield* alice.client.chats.updateMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: {
          contentType: "attachment",
          content: "bread.png",
          attachmentId: upload.id,
        },
      });
      expect(kept.caption).toBe("Baked, then eaten");
      const toText = yield* alice.client.chats.updateMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: { contentType: "text", content: "nevermind" },
      });
      expect(toText.caption).toBeNull();
    }),
  ));
