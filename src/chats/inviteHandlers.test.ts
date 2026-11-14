import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { MAX_GROUP_PARTICIPANTS, MAX_INVITES_PER_CHAT } from "../Api.ts";
import { Db } from "../Db.ts";
import { chatInvites } from "../db/schema.ts";
import { makeTestRun } from "../testApi.ts";
import { insertDummyUsers, registerAndLogin } from "./testKit.ts";

const run = makeTestRun();

// --- Invite links (issue #220) ---

test("createChatInvite is owner/admin only, and joinChatViaInvite adds the redeemer as a member", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const forbidden = yield* bob.client.chats
        .createChatInvite({ params: { id: chat.id }, payload: {} })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });
      expect(invite.chatId).toBe(chat.id);
      expect(invite.useCount).toBe(0);
      expect(invite.revokedAt).toBeNull();

      const joined = yield* carol.client.chats.joinChatViaInvite({
        params: { code: invite.code },
      });
      expect(joined.id).toBe(chat.id);
      const carolParticipant = joined.participants.find(
        (p) => p.userId === carol.user.id,
      );
      expect(carolParticipant?.role).toBe("member");

      const invites = yield* alice.client.chats.listChatInvites({
        params: { id: chat.id },
      });
      expect(invites.find((i) => i.id === invite.id)?.useCount).toBe(1);

      // Joining again with a code you're already in via is a no-op, not an
      // error, and doesn't bump useCount further.
      const rejoined = yield* carol.client.chats.joinChatViaInvite({
        params: { code: invite.code },
      });
      expect(rejoined.id).toBe(chat.id);
      const invitesAfterRejoin = yield* alice.client.chats.listChatInvites({
        params: { id: chat.id },
      });
      expect(invitesAfterRejoin.find((i) => i.id === invite.id)?.useCount).toBe(
        1,
      );
    }),
  ));

test("joinChatViaInvite 404s for an unknown code", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const result = yield* alice.client.chats
        .joinChatViaInvite({ params: { code: "does-not-exist" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("revokeChatInvite invalidates the code for future joins", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });

      yield* alice.client.chats.revokeChatInvite({
        params: { id: chat.id, inviteId: invite.id },
      });

      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const result = yield* carol.client.chats
        .joinChatViaInvite({ params: { code: invite.code } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");

      const doubleRevoke = yield* alice.client.chats
        .revokeChatInvite({ params: { id: chat.id, inviteId: invite.id } })
        .pipe(Effect.flip);
      expect(doubleRevoke._tag).toBe("NotFound");
    }),
  ));

test("joinChatViaInvite enforces expiry and maxUses", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const dave = yield* registerAndLogin("dave", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      // maxUses: 1 — the first join succeeds, the second is rejected.
      const singleUse = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: { maxUses: 1 },
      });
      yield* carol.client.chats.joinChatViaInvite({
        params: { code: singleUse.code },
      });
      const overUse = yield* dave.client.chats
        .joinChatViaInvite({ params: { code: singleUse.code } })
        .pipe(Effect.flip);
      expect(overUse._tag).toBe("InvalidChatRequest");

      // An already-expired invite (simulated by backdating it directly,
      // since expiresInHours can't express "already in the past") is
      // rejected too.
      const expiring = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: { expiresInHours: 1 },
      });
      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db
          .update(chatInvites)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(chatInvites.id, expiring.id)),
      ).pipe(Effect.orDie);
      const expired = yield* dave.client.chats
        .joinChatViaInvite({ params: { code: expiring.code } })
        .pipe(Effect.flip);
      expect(expired._tag).toBe("InvalidChatRequest");
    }),
  ));

test("joinChatViaInvite rejects joining once the group is at its participant cap", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const others = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS - 1);
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [others[0]!.id] },
      });
      yield* alice.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: others.slice(1).map((o) => o.id) },
      });

      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });
      const outsider = yield* registerAndLogin("outsider", "pw-testpass");
      const result = yield* outsider.client.chats
        .joinChatViaInvite({ params: { code: invite.code } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

// Regression test for a TOCTOU race between the pre-transaction `useCount`
// read and the increment: two concurrent redemptions of a `maxUses: 1`
// invite must not both succeed (see the guarded `WHERE useCount < maxUses`
// update in `joinChatViaInvite`, ChatsHandler.ts).
test("joinChatViaInvite serializes concurrent redemptions against maxUses", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const dave = yield* registerAndLogin("dave", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: { maxUses: 1 },
      });

      const [carolResult, daveResult] = yield* Effect.all(
        [
          carol.client.chats
            .joinChatViaInvite({ params: { code: invite.code } })
            .pipe(Effect.result),
          dave.client.chats
            .joinChatViaInvite({ params: { code: invite.code } })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const results = [carolResult, daveResult];
      const succeeded = results.filter((r) => r._tag === "Success");
      const failed = results.filter((r) => r._tag === "Failure");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      if (failed[0]?._tag === "Failure") {
        expect((failed[0].failure as { _tag: string })._tag).toBe(
          "InvalidChatRequest",
        );
      }

      const invites = yield* alice.client.chats.listChatInvites({
        params: { id: chat.id },
      });
      expect(invites.find((i) => i.id === invite.id)?.useCount).toBe(1);
    }),
  ));

test("createChatInvite doesn't count revoked/expired invites toward the per-chat cap", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const invites = [];
      for (let i = 0; i < MAX_INVITES_PER_CHAT; i++) {
        invites.push(
          yield* alice.client.chats.createChatInvite({
            params: { id: chat.id },
            payload: {},
          }),
        );
      }

      const atCap = yield* alice.client.chats
        .createChatInvite({ params: { id: chat.id }, payload: {} })
        .pipe(Effect.flip);
      expect(atCap._tag).toBe("InvalidChatRequest");

      // Revoking one frees a slot even though the row itself still exists.
      yield* alice.client.chats.revokeChatInvite({
        params: { id: chat.id, inviteId: invites[0]!.id },
      });
      const afterRevoke = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });
      expect(afterRevoke.chatId).toBe(chat.id);
    }),
  ));
