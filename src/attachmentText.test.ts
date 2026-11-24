import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect } from "effect";
import sharp from "sharp";
import { type Attachment, ChatApi } from "./Api.ts";
import { Db } from "./Db.ts";
import { attachments, messages, posts, users } from "./db/schema.ts";
import { makeTestRun } from "./testApi.ts";

// Posts and messages with an attachment, with and without text beside it
// (issues #765 and #941).

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

test("a post can carry text beside its attachment, and either on its own", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const upload = yield* uploadPng(handler, alice.accessToken);
      const created = yield* alice.client.posts.createPost({
        payload: {
          attachmentId: upload.id,
          body: "Look what I baked https://example.com",
        },
      });
      expect(created.body).toBe("Look what I baked https://example.com");
      expect(created.attachment!.id).toBe(upload.id);

      const fetched = yield* alice.client.posts.getPost({
        params: { id: created.id },
      });
      expect(fetched.body).toBe("Look what I baked https://example.com");
      const feed = yield* alice.client.posts.listPosts({ query: {} });
      expect(feed.posts[0]!.body).toBe("Look what I baked https://example.com");

      const changed = yield* alice.client.posts.updatePost({
        params: { id: created.id },
        payload: {
          attachmentId: upload.id,
          body: "Sourdough, day 3",
        },
      });
      expect(changed.body).toBe("Sourdough, day 3");
      const cleared = yield* alice.client.posts.updatePost({
        params: { id: created.id },
        payload: {
          attachmentId: upload.id,
          body: "",
        },
      });
      expect(cleared.body).toBe("");
      expect(cleared.attachment!.id).toBe(upload.id);
      // An edit without an attachment removes it.
      const toText = yield* alice.client.posts.updatePost({
        params: { id: created.id },
        payload: { body: "just words" },
      });
      expect(toText.body).toBe("just words");
      expect(toText.attachment).toBeNull();
      const plain = yield* alice.client.posts.createPost({
        payload: { body: "just text" },
      });
      expect(plain.attachment).toBeNull();
    }),
  ));

test("an empty body without an attachment is rejected", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const post = yield* alice.client.posts.createPost({
        payload: { body: "hello" },
      });
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "hello" },
      });
      for (const [method, path] of [
        ["POST", "/posts"],
        ["PUT", `/posts/${post.id}`],
        ["POST", `/chats/${chat.id}/messages`],
        ["PUT", `/chats/${chat.id}/messages/${message.id}`],
      ] as const) {
        const response = yield* rawJson(
          handler,
          alice.accessToken,
          method,
          path,
          { body: "" },
        );
        expect([method, path, response.status]).toEqual([method, path, 400]);
        const error = (yield* Effect.promise(() => response.json())) as {
          message: string;
        };
        expect(error.message).toBe(
          "body may only be empty when there is an attachment",
        );
      }
    }),
  ));

// The `set null` FK must not be blocked by an empty body.
test("deleting an attachment leaves a post without text behind, empty", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const alice = yield* registerAndLogin("alice");
      const upload = yield* uploadPng(handler, alice.accessToken);
      const post = yield* alice.client.posts.createPost({
        payload: { body: "", attachmentId: upload.id },
      });
      yield* Effect.promise(() =>
        db.delete(attachments).where(eq(attachments.id, upload.id)),
      );
      const after = yield* alice.client.posts.getPost({
        params: { id: post.id },
      });
      expect(after.body).toBe("");
      expect(after.attachment).toBeNull();
    }),
  ));

test("an @mention beside an attachment notifies, and the text is its excerpt", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      const upload = yield* uploadPng(handler, alice.accessToken);
      const post = yield* alice.client.posts.createPost({
        payload: {
          attachmentId: upload.id,
          body: "baked this with @bob",
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
          attachmentId: upload.id,
          body: "baked this with @bob and @carol",
        },
      });
      expect(
        (yield* bob.client.notifications.listNotifications({ query: {} }))
          .notifications.length,
      ).toBe(1);
      expect(
        (yield* carol.client.notifications.listNotifications({
          query: {},
        })).notifications.map((n) => n.type),
      ).toEqual(["mention"]);
    }),
  ));

test("search finds the text beside an attachment, but never its filename", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const postUpload = yield* uploadPng(handler, alice.accessToken);
      const post = yield* alice.client.posts.createPost({
        payload: {
          attachmentId: postUpload.id,
          body: "Freshly baked sourdough",
        },
      });
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const messageUpload = yield* uploadPng(handler, alice.accessToken);
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          attachmentId: messageUpload.id,
          body: "Harbor at dusk",
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

test("a chat message carries its text through replies and forwards", () =>
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
          attachmentId: upload.id,
          body: "Look what I baked",
        },
      });
      expect(original.body).toBe("Look what I baked");

      const listed = yield* bob.client.chats.listMessages({
        params: { id: aliceBob.id },
        query: {},
      });
      expect(listed.messages.find((m) => m.id === original.id)!.body).toBe(
        "Look what I baked",
      );

      // A reply's quote shows the text, not only "Attachment".
      const reply = yield* bob.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: {
          body: "yum",
          parentMessageId: original.id,
        },
      });
      expect(reply.parentMessage).toMatchObject({
        body: "Look what I baked",
        hasAttachment: true,
      });

      // A forward copies the text with its attachment.
      const { results } = yield* bob.client.chats.forwardMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: { targetChatIds: [bobCarol.id] },
      });
      const copy = results[0]!.message!;
      expect(copy.body).toBe("Look what I baked");
      expect(copy.attachment!.id).not.toBe(upload.id);
      const [copyRow] = yield* Effect.promise(() =>
        db.select().from(messages).where(eq(messages.id, copy.id)),
      );
      expect(copyRow!.body).toBe("Look what I baked");

      // Editing the text, clearing it, and removing the attachment.
      const edited = yield* alice.client.chats.updateMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: {
          attachmentId: upload.id,
          body: "Baked, then eaten",
        },
      });
      expect(edited.body).toBe("Baked, then eaten");
      const cleared = yield* alice.client.chats.updateMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: {
          body: "",
          attachmentId: upload.id,
        },
      });
      expect(cleared.body).toBe("");
      const toText = yield* alice.client.chats.updateMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: { body: "nevermind" },
      });
      expect(toText.attachment).toBeNull();
    }),
  ));

// Issue #896: an edit that keeps its file isn't attaching a new one, and an
// attachment is on at most one post or message.

const makeAdmin = (username: string) =>
  Effect.gen(function* () {
    const { user } = yield* registerAndLogin(username);
    const db = yield* Db;
    yield* Effect.promise(() =>
      db.update(users).set({ role: "admin" }).where(eq(users.id, user.id)),
    );
    // Log in again so the token carries the admin role.
    const { accessToken } = yield* (yield* makeClient).users.login({
      payload: { username, password: "pw-testpass" },
    });
    return { user, accessToken, client: yield* makeAuthedClient(accessToken) };
  });

const attachmentBody = (attachmentId: number, body = "") => ({
  body,
  attachmentId,
});

test("an admin can edit the text of someone else's attachment post and message", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const admin = yield* makeAdmin("admin1");
      const upload = yield* uploadPng(handler, alice.accessToken);
      const post = yield* alice.client.posts.createPost({
        payload: attachmentBody(upload.id, "Lok what I baked"),
      });
      const edited = yield* admin.client.posts.updatePost({
        params: { id: post.id },
        payload: attachmentBody(upload.id, "Look what I baked"),
      });
      expect(edited.body).toBe("Look what I baked");
      expect(edited.attachment!.id).toBe(upload.id);

      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: admin.user.id },
      });
      const messageUpload = yield* uploadPng(handler, alice.accessToken);
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: attachmentBody(messageUpload.id, "tpyo"),
      });
      // Only an accepted participant may edit.
      yield* admin.client.chats.acceptChatRequest({ params: { id: chat.id } });
      const editedMessage = yield* admin.client.chats.updateMessage({
        params: { id: chat.id, messageId: message.id },
        payload: attachmentBody(messageUpload.id, "typo"),
      });
      expect(editedMessage.body).toBe("typo");
      expect(editedMessage.attachment!.id).toBe(messageUpload.id);

      // A different file still has to be the admin's own.
      const unused = yield* uploadPng(handler, alice.accessToken);
      const refused = yield* admin.client.posts
        .updatePost({
          params: { id: post.id },
          payload: attachmentBody(unused.id),
        })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("NotFound");
    }),
  ));

test("an attachment already on a post or message can't go on another", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const onPost = yield* uploadPng(handler, alice.accessToken);
      const onMessage = yield* uploadPng(handler, alice.accessToken);
      const body = attachmentBody(onPost.id);
      const post = yield* alice.client.posts.createPost({ payload: body });
      yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: attachmentBody(onMessage.id),
      });
      const otherPost = yield* alice.client.posts.createPost({
        payload: { body: "hi" },
      });
      const otherMessage = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "hi" },
      });

      for (const { id } of [onPost, onMessage]) {
        const payload = attachmentBody(id);
        for (const [method, path] of [
          ["POST", "/posts"],
          ["PUT", `/posts/${otherPost.id}`],
          ["POST", `/chats/${chat.id}/messages`],
          ["PUT", `/chats/${chat.id}/messages/${otherMessage.id}`],
        ] as const) {
          const response = yield* rawJson(
            handler,
            alice.accessToken,
            method,
            path,
            payload,
          );
          expect([method, path, response.status]).toEqual([method, path, 409]);
        }
      }

      // Once its post is gone, the file is free again.
      yield* alice.client.posts.deletePost({ params: { id: post.id } });
      const again = yield* alice.client.posts.updatePost({
        params: { id: otherPost.id },
        payload: body,
      });
      expect(again.attachment!.id).toBe(onPost.id);
    }),
  ));

test("a row that already shares its attachment stays editable, and a retried create isn't a conflict", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const upload = yield* uploadPng(handler, alice.accessToken);
      const payload = { ...attachmentBody(upload.id), clientId: "retry-1" };
      const post = yield* alice.client.posts.createPost({ payload });
      const retried = yield* alice.client.posts.createPost({ payload });
      expect(retried.id).toBe(post.id);

      const db = yield* Db;
      yield* Effect.promise(() =>
        db.insert(posts).values({
          authorId: alice.user.id,
          body: "",
          attachmentId: upload.id,
        }),
      );
      const edited = yield* alice.client.posts.updatePost({
        params: { id: post.id },
        payload: attachmentBody(upload.id, "still mine"),
      });
      expect(edited.body).toBe("still mine");
    }),
  ));
