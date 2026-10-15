import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect } from "effect";
import sharp from "sharp";
import { type Attachment, ChatApi, MAX_FORWARD_TARGETS } from "./Api.ts";
import { ATTACHMENT_QUOTA_MAX_BYTES } from "./AttachmentsHandler.ts";
import { Db } from "./Db.ts";
import { attachments, messages, users } from "./db/schema.ts";
import { makeTestRun } from "./testApi.ts";

// Forwarding chat messages (issue #601).

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
    return {
      user,
      password,
      accessToken,
      client: yield* makeAuthedClient(accessToken),
    };
  });

type Handler = (request: Request) => Promise<Response>;

const uploadPng = (handler: Handler, token: string) =>
  Effect.promise(async () => {
    const png = await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 3,
        background: { r: 200, g: 40, b: 90 },
      },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "photo.png");
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

// A raw POST, for bodies the typed client refuses to encode at all.
const postForward = (
  handler: Handler,
  token: string,
  chatId: number,
  messageId: number,
  body: unknown,
) =>
  Effect.promise(() =>
    handler(
      new Request(
        `http://localhost/chats/${chatId}/messages/${messageId}/forward`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      ),
    ),
  );

test("forwardMessage posts a labelled copy, owned by the forwarder, into each target", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");

      const aliceBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const bobCarol = yield* bob.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const group = yield* bob.client.chats.createGroupChat({
        payload: { title: "Team", participantIds: [carol.user.id] },
      });
      const original = yield* alice.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: { contentType: "text", content: "hello @carol" },
      });

      const { results } = yield* bob.client.chats.forwardMessage({
        params: { id: aliceBob.id, messageId: original.id },
        // Duplicates collapse, and the source chat is a fine target.
        payload: {
          targetChatIds: [bobCarol.id, group.id, bobCarol.id, aliceBob.id],
        },
      });
      expect(results.map((r) => r.chatId)).toEqual([
        bobCarol.id,
        group.id,
        aliceBob.id,
      ]);
      for (const result of results) {
        expect(result.error).toBeNull();
        const copy = result.message!;
        expect(copy.chatId).toBe(result.chatId);
        expect(copy.id).not.toBe(original.id);
        expect(copy.senderId).toBe(bob.user.id);
        expect(copy.content).toBe("hello @carol");
        expect(copy.forwardedFrom).toEqual({
          senderId: alice.user.id,
          senderName: "alice",
        });
        expect(copy.reactions).toEqual([]);
        expect(copy.readByUserIds).toEqual([]);
      }

      // Carol sees it in her chat with Bob, labelled.
      const page = yield* carol.client.chats.listMessages({
        params: { id: bobCarol.id },
        query: {},
      });
      expect(page.messages.length).toBe(1);
      expect(page.messages[0]!.forwardedFrom?.senderName).toBe("alice");

      // The chat list's last-message line carries the label too.
      const list = yield* carol.client.chats.listChats({ query: {} });
      const row = list.chats.find((c) => c.id === bobCarol.id);
      expect(row?.lastMessage?.forwardedFrom?.senderName).toBe("alice");

      // The forwarder owns the copy: they can edit and delete it.
      const copyId = results[0]!.message!.id;
      const edited = yield* bob.client.chats.updateMessage({
        params: { id: bobCarol.id, messageId: copyId },
        payload: { contentType: "text", content: "edited copy" },
      });
      expect(edited.forwardedFrom?.senderName).toBe("alice");
      yield* bob.client.chats.deleteMessage({
        params: { id: bobCarol.id, messageId: copyId },
      });
    }),
  ));

test("forwardMessage 404s for a chat the caller isn't in, or a message from another chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");

      const aliceBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const aliceCarol = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const secret = yield* alice.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: { contentType: "text", content: "between us" },
      });

      // Carol isn't in Alice<->Bob: 404, not 403.
      const notMember = yield* carol.client.chats
        .forwardMessage({
          params: { id: aliceBob.id, messageId: secret.id },
          payload: { targetChatIds: [aliceCarol.id] },
        })
        .pipe(Effect.flip);
      expect(notMember._tag).toBe("NotFound");

      // Pairing a chat Carol is in with a message from another chat: 404.
      const wrongChat = yield* carol.client.chats
        .forwardMessage({
          params: { id: aliceCarol.id, messageId: secret.id },
          payload: { targetChatIds: [aliceCarol.id] },
        })
        .pipe(Effect.flip);
      expect(wrongChat._tag).toBe("NotFound");

      const nonexistent = yield* alice.client.chats
        .forwardMessage({
          params: { id: 99999, messageId: secret.id },
          payload: { targetChatIds: [aliceCarol.id] },
        })
        .pipe(Effect.flip);
      expect(nonexistent._tag).toBe("NotFound");
    }),
  ));

test("forwardMessage fails only the targets the caller can't post into", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      const dave = yield* registerAndLogin("dave");
      const erin = yield* registerAndLogin("erin");

      const aliceBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const aliceCarol = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const aliceDave = yield* alice.client.chats.createDirectChat({
        payload: { userId: dave.user.id },
      });
      const aliceErin = yield* alice.client.chats.createDirectChat({
        payload: { userId: erin.user.id },
      });
      // A chat Alice isn't in, and a group she has left.
      const bobCarol = yield* bob.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const leftGroup = yield* bob.client.chats.createGroupChat({
        payload: { title: "Old team", participantIds: [alice.user.id] },
      });
      yield* alice.client.chats.leaveChat({ params: { id: leftGroup.id } });

      // Carol blocked Alice; Dave only muted her.
      yield* carol.client.users.setBlock({
        params: { id: alice.user.id },
        payload: { type: "block" },
      });
      yield* dave.client.users.setBlock({
        params: { id: alice.user.id },
        payload: { type: "mute" },
      });

      const message = yield* alice.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: { contentType: "text", content: "news" },
      });
      const { results } = yield* alice.client.chats.forwardMessage({
        params: { id: aliceBob.id, messageId: message.id },
        payload: {
          targetChatIds: [
            aliceCarol.id,
            bobCarol.id,
            leftGroup.id,
            99999,
            aliceDave.id,
            aliceErin.id,
          ],
        },
      });
      const byChat = new Map(results.map((r) => [r.chatId, r]));
      expect(byChat.get(aliceCarol.id)?.error?.reason).toBe("blocked");
      expect(byChat.get(bobCarol.id)?.error?.reason).toBe("unavailable");
      expect(byChat.get(leftGroup.id)?.error?.reason).toBe("unavailable");
      expect(byChat.get(99999)?.error?.reason).toBe("unavailable");
      // A mute never stops a send, forwarded or not.
      expect(byChat.get(aliceDave.id)?.message?.content).toBe("news");
      expect(byChat.get(aliceErin.id)?.message?.content).toBe("news");

      // Nothing was written into the chats that failed.
      const bobsGroup = yield* bob.client.chats.listMessages({
        params: { id: leftGroup.id },
        query: {},
      });
      expect(bobsGroup.messages).toEqual([]);
    }),
  ));

test("a forwarded attachment is a copy the forwarder owns, and outlives the original", () =>
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
          content: "photo.png",
          attachmentId: upload.id,
        },
      });

      const { results } = yield* bob.client.chats.forwardMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: { targetChatIds: [bobCarol.id] },
      });
      const copy = results[0]!.message!;
      expect(copy.contentType).toBe("attachment");
      expect(copy.attachment).not.toBeNull();
      expect(copy.attachment!.id).not.toBe(upload.id);
      // Every bit of metadata carries over.
      expect(copy.attachment!.width).toBe(upload.width);
      expect(copy.attachment!.height).toBe(upload.height);
      expect(copy.attachment!.blurhash).toBe(upload.blurhash);
      expect(copy.attachment!.mimeType).toBe(upload.mimeType);
      expect(copy.attachment!.size).toBe(upload.size);
      expect(copy.attachment!.url).toStartWith("data:image/");

      const copyRow = (yield* Effect.promise(() =>
        db
          .select()
          .from(attachments)
          .where(eq(attachments.id, copy.attachment!.id)),
      ))[0]!;
      expect(copyRow.uploaderId).toBe(bob.user.id);

      // Alice deletes her upload, then her whole account.
      yield* alice.client.attachments.deleteAttachment({
        params: { id: upload.id },
      });
      yield* alice.client.users.deleteAccount({
        payload: { password: alice.password },
      });

      const page = yield* carol.client.chats.listMessages({
        params: { id: bobCarol.id },
        query: {},
      });
      const survived = page.messages[0]!;
      expect(survived.id).toBe(copy.id);
      expect(survived.attachment?.id).toBe(copy.attachment!.id);
      expect(survived.attachment?.url).toStartWith("data:image/");
      // The label keeps the name, but no longer points at a dead account.
      expect(survived.forwardedFrom).toEqual({
        senderId: null,
        senderName: "alice",
      });
    }),
  ));

test("a forward is a snapshot: editing or deleting the original leaves it alone", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");

      const aliceBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const bobCarol = yield* bob.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const original = yield* alice.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: { contentType: "text", content: "first draft" },
      });
      const { results } = yield* bob.client.chats.forwardMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: { targetChatIds: [bobCarol.id] },
      });
      const copy = results[0]!.message!;

      yield* alice.client.users.updateProfile({
        payload: { displayName: "Alice Renamed", avatarUrl: null },
      });
      yield* alice.client.chats.updateMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: { contentType: "text", content: "second draft" },
      });
      let page = yield* carol.client.chats.listMessages({
        params: { id: bobCarol.id },
        query: {},
      });
      expect(page.messages[0]!.content).toBe("first draft");
      expect(page.messages[0]!.forwardedFrom?.senderName).toBe("alice");

      yield* alice.client.chats.deleteMessage({
        params: { id: aliceBob.id, messageId: original.id },
      });
      page = yield* carol.client.chats.listMessages({
        params: { id: bobCarol.id },
        query: {},
      });
      expect(page.messages.map((m) => m.id)).toEqual([copy.id]);
      expect(page.messages[0]!.content).toBe("first draft");
    }),
  ));

test("forwarding a forward credits the original author, and a reply's quote isn't copied", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      const dave = yield* registerAndLogin("dave");

      const aliceBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const bobCarol = yield* bob.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const carolDave = yield* carol.client.chats.createDirectChat({
        payload: { userId: dave.user.id },
      });
      const question = yield* bob.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: { contentType: "text", content: "lunch?" },
      });
      const reply = yield* alice.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: {
          contentType: "text",
          content: "yes, noon",
          parentMessageId: question.id,
        },
      });
      expect(reply.parentMessage?.id).toBe(question.id);

      const first = yield* bob.client.chats.forwardMessage({
        params: { id: aliceBob.id, messageId: reply.id },
        payload: { targetChatIds: [bobCarol.id] },
      });
      const hop = first.results[0]!.message!;
      expect(hop.parentMessage).toBeNull();

      const second = yield* carol.client.chats.forwardMessage({
        params: { id: bobCarol.id, messageId: hop.id },
        payload: { targetChatIds: [carolDave.id] },
      });
      const twoHops = second.results[0]!.message!;
      expect(twoHops.senderId).toBe(carol.user.id);
      expect(twoHops.forwardedFrom).toEqual({
        senderId: alice.user.id,
        senderName: "alice",
      });

      // A reply quoting a forward says so in its quote.
      const quoting = yield* dave.client.chats.createMessage({
        params: { id: carolDave.id },
        payload: {
          contentType: "text",
          content: "noted",
          parentMessageId: twoHops.id,
        },
      });
      expect(quoting.parentMessage?.forwarded).toBe(true);
    }),
  ));

test("replaying a forward's clientId creates no duplicates and fills in only the missing targets", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");

      const aliceBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const aliceCarol = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const group = yield* bob.client.chats.createGroupChat({
        payload: { title: "Later", participantIds: [carol.user.id] },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: { contentType: "text", content: "pass it on" },
      });
      const forward = {
        params: { id: aliceBob.id, messageId: message.id },
        payload: {
          targetChatIds: [aliceCarol.id, group.id],
          clientId: "fwd-1",
        },
      };

      // Alice isn't in the group yet, so only Carol gets it.
      const first = yield* alice.client.chats.forwardMessage(forward);
      expect(first.results[0]!.message).not.toBeNull();
      expect(first.results[1]!.error?.reason).toBe("unavailable");

      yield* bob.client.chats.addParticipants({
        params: { id: group.id },
        payload: { participantIds: [alice.user.id] },
      });
      const replay = yield* alice.client.chats.forwardMessage(forward);
      expect(replay.results[0]!.message!.id).toBe(
        first.results[0]!.message!.id,
      );
      expect(replay.results[1]!.message?.content).toBe("pass it on");

      const again = yield* alice.client.chats.forwardMessage(forward);
      expect(again.results.map((r) => r.message?.id)).toEqual(
        replay.results.map((r) => r.message?.id),
      );

      const copies = yield* Effect.promise(() =>
        db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.senderId, alice.user.id)),
      );
      // The original plus exactly one copy per target.
      expect(copies.length).toBe(3);
    }),
  ));

test("forwardMessage rejects an empty or oversized target list with a 400", () =>
  run(({ handler }) =>
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "hi" },
      });

      const empty = yield* postForward(
        handler,
        alice.accessToken,
        chat.id,
        message.id,
        { targetChatIds: [] },
      );
      expect(empty.status).toBe(400);

      const tooMany = yield* postForward(
        handler,
        alice.accessToken,
        chat.id,
        message.id,
        {
          targetChatIds: Array.from(
            { length: MAX_FORWARD_TARGETS + 1 },
            (_, i) => i + 1,
          ),
        },
      );
      expect(tooMany.status).toBe(400);
    }),
  ));

test("an image URL whose host is no longer allowed fails every target", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      const aliceBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const aliceCarol = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      // Stored before the allowlist changed — written directly, since the
      // API would now refuse it.
      const [stale] = yield* Effect.promise(() =>
        db
          .insert(messages)
          .values({
            chatId: aliceBob.id,
            senderId: alice.user.id,
            contentType: "image_url",
            content: "https://no-longer-allowed.example/cat.png",
          })
          .returning(),
      );

      const { results } = yield* alice.client.chats.forwardMessage({
        params: { id: aliceBob.id, messageId: stale!.id },
        payload: { targetChatIds: [aliceCarol.id] },
      });
      expect(results[0]!.error?.reason).toBe("invalid_content");
    }),
  ));

test("forwarded text is searchable by the target chat's members only", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");

      const aliceBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const bobCarol = yield* bob.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: aliceBob.id },
        payload: { contentType: "text", content: "the zeppelin lands" },
      });
      yield* bob.client.chats.forwardMessage({
        params: { id: aliceBob.id, messageId: message.id },
        payload: { targetChatIds: [bobCarol.id] },
      });

      const carols = yield* carol.client.search.searchMessages({
        query: { q: "zeppelin" },
      });
      expect(carols.results.map((r) => r.chatId)).toEqual([bobCarol.id]);
      const alices = yield* alice.client.search.searchMessages({
        query: { q: "zeppelin" },
      });
      expect(alices.results.map((r) => r.chatId)).toEqual([aliceBob.id]);
    }),
  ));

test("a forwarded attachment counts toward the forwarder's quota, failing only that target", () =>
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
          content: "photo.png",
          attachmentId: upload.id,
        },
      });

      // Bob's storage is full.
      yield* Effect.promise(() =>
        db
          .update(users)
          .set({ storageUsedBytes: ATTACHMENT_QUOTA_MAX_BYTES })
          .where(eq(users.id, bob.user.id)),
      );
      const { results } = yield* bob.client.chats.forwardMessage({
        params: { id: aliceBob.id, messageId: original.id },
        payload: { targetChatIds: [bobCarol.id] },
      });
      expect(results[0]!.error?.reason).toBe("quota_exceeded");

      // Nothing half-made was left behind.
      const bobsUploads = yield* Effect.promise(() =>
        db
          .select()
          .from(attachments)
          .where(eq(attachments.uploaderId, bob.user.id)),
      );
      expect(bobsUploads).toEqual([]);
    }),
  ));
