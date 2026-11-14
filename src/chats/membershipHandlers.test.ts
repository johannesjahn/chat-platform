import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { MAX_GROUP_PARTICIPANTS } from "../Api.ts";
import { Db } from "../Db.ts";
import { users } from "../db/schema.ts";
import { makeTestRun } from "../testApi.ts";
import {
  insertDummyUsers,
  promoteToAdmin,
  registerAndLogin,
} from "./testKit.ts";

const run = makeTestRun();

test("createGroupChat creates a chat with the creator plus given participants", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");

      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Trip planning",
          participantIds: [bob.user.id, carol.user.id],
        },
      });
      expect(chat.type).toBe("group");
      expect(chat.title).toBe("Trip planning");
      expect(chat.createdBy).toBe(alice.user.id);
      expect(chat.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, bob.user.id, carol.user.id].sort(),
      );
    }),
  ));

test("createGroupChat rejects duplicate participant ids", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const result = yield* alice.client.chats
        .createGroupChat({
          payload: {
            title: "Dup",
            participantIds: [bob.user.id, bob.user.id],
          },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

test("createGroupChat rejects including yourself in participantIds", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const result = yield* alice.client.chats
        .createGroupChat({
          payload: {
            title: "Self",
            participantIds: [bob.user.id, alice.user.id],
          },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

test("createGroupChat 404s when a participant doesn't exist", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const result = yield* alice.client.chats
        .createGroupChat({
          payload: { title: "Ghost", participantIds: [9999] },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("addParticipants lets the creator add people, up to the group cap", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");

      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const updated = yield* alice.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: [carol.user.id] },
      });
      expect(updated.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, bob.user.id, carol.user.id].sort(),
      );

      // Adding someone who's already in doesn't error and doesn't duplicate.
      const again = yield* alice.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: [carol.user.id] },
      });
      expect(again.participants).toHaveLength(3);
    }),
  ));

test("addParticipants is forbidden for non-creators and rejects exceeding the cap", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const forbidden = yield* bob.client.chats
        .addParticipants({
          params: { id: chat.id },
          payload: { participantIds: [alice.user.id] },
        })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      // Fill up remaining slots, then try to push one past the cap. Two
      // participants (alice, bob) are already in, so this is the max group
      // size minus 2 more, plus one over.
      const others = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS - 1);
      const toAdd = others
        .slice(0, MAX_GROUP_PARTICIPANTS - 2)
        .map((o) => o.id);
      yield* alice.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: toAdd },
      });
      const overCap = yield* alice.client.chats
        .addParticipants({
          params: { id: chat.id },
          payload: {
            participantIds: [others[MAX_GROUP_PARTICIPANTS - 2]!.id],
          },
        })
        .pipe(Effect.flip);
      expect(overCap._tag).toBe("InvalidChatRequest");
    }),
  ));

test("addParticipants does not exceed the group cap when two requests race", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Race", participantIds: [bob.user.id] },
      });
      // 2 participants so far (alice, bob); cap is 20, so 18 slots remain.
      const pool = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS - 1);
      const fillsTheCap = pool.slice(0, MAX_GROUP_PARTICIPANTS - 2);
      const oneMore = pool[MAX_GROUP_PARTICIPANTS - 2]!;

      // One request fills every remaining slot exactly to the cap; the
      // other adds one further user. Run concurrently — combined, they'd
      // push the group to 21 members if the cap check weren't atomic with
      // the insert.
      const [fillResult, oneMoreResult] = yield* Effect.all(
        [
          alice.client.chats
            .addParticipants({
              params: { id: chat.id },
              payload: { participantIds: fillsTheCap.map((u) => u.id) },
            })
            .pipe(Effect.result),
          alice.client.chats
            .addParticipants({
              params: { id: chat.id },
              payload: { participantIds: [oneMore.id] },
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );

      const outcomes = [fillResult, oneMoreResult];
      const succeeded = outcomes.filter((r) => r._tag === "Success");
      const failed = outcomes.filter((r) => r._tag === "Failure");
      // Exactly one of the two racing requests must have been rejected —
      // both together would have exceeded the cap.
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(
        (failed[0] as unknown as { failure: { _tag: string } }).failure._tag,
      ).toBe("InvalidChatRequest");

      const finalChat = yield* alice.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(finalChat.participants.length).toBeLessThanOrEqual(
        MAX_GROUP_PARTICIPANTS,
      );
    }),
  ));

test("deleting a group chat's creator sets createdBy to null instead of deleting the chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Survives", participantIds: [bob.user.id] },
      });

      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db.delete(users).where(eq(users.id, alice.user.id)),
      ).pipe(Effect.orDie);

      const survived = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(survived.title).toBe("Survives");
      expect(survived.createdBy).toBeNull();
      expect(survived.participants.map((p) => p.userId)).toContain(bob.user.id);

      // With no creator left, renaming is now forbidden for everyone.
      const result = yield* bob.client.chats
        .updateChat({ params: { id: chat.id }, payload: { title: "Nope" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");
    }),
  ));

test("createGroupChat's participant list is capped at the schema level", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const pool = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS);

      // Exactly at the limit (19 others + the creator = 20 total) succeeds.
      const atCap = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "At cap",
          participantIds: pool
            .slice(0, MAX_GROUP_PARTICIPANTS - 1)
            .map((u) => u.id),
        },
      });
      expect(atCap.participants).toHaveLength(MAX_GROUP_PARTICIPANTS);

      // One more than that is rejected by the payload schema itself
      // (Schema.maxItems on participantIds) before it ever reaches the
      // handler's own cap check.
      yield* alice.client.chats
        .createGroupChat({
          payload: {
            title: "Over cap",
            participantIds: pool
              .slice(0, MAX_GROUP_PARTICIPANTS)
              .map((u) => u.id),
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("addParticipants's participant list is capped at the schema level", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      const pool = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS);

      // A single addParticipants request can never legitimately add more
      // than MAX_GROUP_PARTICIPANTS - 1 people (the creator already takes
      // one slot) — this is rejected by the payload schema itself
      // (Schema.maxItems), before it ever reaches the handler's own cap
      // check.
      yield* alice.client.chats
        .addParticipants({
          params: { id: chat.id },
          payload: { participantIds: pool.map((u) => u.id) },
        })
        .pipe(Effect.flip);
    }),
  ));

test("addParticipants rejects adding people to a direct chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const result = yield* alice.client.chats
        .addParticipants({
          params: { id: chat.id },
          payload: { participantIds: [carol.user.id] },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

test("leaveChat lets a non-creator leave, keeping the chat for the rest", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      yield* bob.client.chats.leaveChat({ params: { id: chat.id } });

      const survived = yield* alice.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(survived.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, carol.user.id].sort(),
      );
      expect(survived.createdBy).toBe(alice.user.id);

      // bob is no longer a participant, so the chat still exists but is now
      // forbidden to him.
      const afterLeave = yield* bob.client.chats
        .getChat({ params: { id: chat.id } })
        .pipe(Effect.flip);
      expect(afterLeave._tag).toBe("Forbidden");
    }),
  ));

test("leaveChat rejects leaving a direct chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const result = yield* alice.client.chats
        .leaveChat({ params: { id: chat.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

test("leaveChat transfers ownership to the longest-standing remaining participant when the creator leaves, and deletes the chat once empty", () =>
  run(
    Effect.gen(function* () {
      // bob and carol are added to the group in the same insert, so they
      // share a joinedAt — the tie-break (lowest userId) picks bob, since he
      // registered (and so got his id) before carol.
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      yield* alice.client.chats.leaveChat({ params: { id: chat.id } });

      const afterAliceLeft = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(afterAliceLeft.createdBy).toBe(bob.user.id);
      expect(afterAliceLeft.participants.map((p) => p.userId).sort()).toEqual(
        [bob.user.id, carol.user.id].sort(),
      );

      yield* carol.client.chats.leaveChat({ params: { id: chat.id } });
      yield* bob.client.chats.leaveChat({ params: { id: chat.id } });

      // Once the last participant leaves, the chat is deleted outright.
      const gone = yield* bob.client.chats
        .getChat({ params: { id: chat.id } })
        .pipe(Effect.flip);
      expect(gone._tag).toBe("NotFound");
    }),
  ));

test("removeParticipant lets the creator remove someone, and an admin who isn't a participant too", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      const updated = yield* alice.client.chats.removeParticipant({
        params: { id: chat.id, userId: bob.user.id },
      });
      expect(updated.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, carol.user.id].sort(),
      );

      // Non-creator, non-admin can't remove anyone.
      const forbidden = yield* carol.client.chats
        .removeParticipant({ params: { id: chat.id, userId: alice.user.id } })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      yield* registerAndLogin("dave", "pw-testpass");
      const adminClient = yield* promoteToAdmin("dave", "pw-testpass");
      const asAdmin = yield* adminClient.chats.removeParticipant({
        params: { id: chat.id, userId: carol.user.id },
      });
      expect(asAdmin.participants.map((p) => p.userId)).toEqual([
        alice.user.id,
      ]);
    }),
  ));

test("removeParticipant rejects removing yourself, a non-participant, or the chat's last participant", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const removeSelf = yield* alice.client.chats
        .removeParticipant({ params: { id: chat.id, userId: alice.user.id } })
        .pipe(Effect.flip);
      expect(removeSelf._tag).toBe("InvalidChatRequest");

      const removeStranger = yield* alice.client.chats
        .removeParticipant({ params: { id: chat.id, userId: carol.user.id } })
        .pipe(Effect.flip);
      expect(removeStranger._tag).toBe("NotFound");

      // Shrink the chat down to bob alone (ownership transfers to him),
      // then have an admin try to remove the last remaining participant.
      yield* alice.client.chats.leaveChat({ params: { id: chat.id } });
      yield* registerAndLogin("erin", "pw-testpass");
      const adminClient = yield* promoteToAdmin("erin", "pw-testpass");
      const removeLast = yield* adminClient.chats
        .removeParticipant({ params: { id: chat.id, userId: bob.user.id } })
        .pipe(Effect.flip);
      expect(removeLast._tag).toBe("InvalidChatRequest");
    }),
  ));

test("removeParticipant transfers ownership when the removed participant was the creator", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      yield* registerAndLogin("dave", "pw-testpass");
      const adminClient = yield* promoteToAdmin("dave", "pw-testpass");
      yield* adminClient.chats.removeParticipant({
        params: { id: chat.id, userId: alice.user.id },
      });

      const afterRemoval = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(afterRemoval.createdBy).toBe(bob.user.id);
      expect(afterRemoval.participants.map((p) => p.userId).sort()).toEqual(
        [bob.user.id, carol.user.id].sort(),
      );
    }),
  ));

test("deleteChat lets the creator (or an admin) delete a group chat outright", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");

      const directChat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const directResult = yield* alice.client.chats
        .deleteChat({ params: { id: directChat.id } })
        .pipe(Effect.flip);
      expect(directResult._tag).toBe("InvalidChatRequest");

      const groupChat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      const forbidden = yield* bob.client.chats
        .deleteChat({ params: { id: groupChat.id } })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      yield* alice.client.chats.deleteChat({ params: { id: groupChat.id } });

      const gone = yield* bob.client.chats
        .getChat({ params: { id: groupChat.id } })
        .pipe(Effect.flip);
      expect(gone._tag).toBe("NotFound");
    }),
  ));

test("transferOwnership lets the creator hand off ownership, and 404s for a non-participant target", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const missingTarget = yield* alice.client.chats
        .transferOwnership({
          params: { id: chat.id },
          payload: { userId: carol.user.id },
        })
        .pipe(Effect.flip);
      expect(missingTarget._tag).toBe("NotFound");

      const updated = yield* alice.client.chats.transferOwnership({
        params: { id: chat.id },
        payload: { userId: bob.user.id },
      });
      expect(updated.createdBy).toBe(bob.user.id);

      // Ownership moved — alice can no longer rename, bob now can.
      const renameByAlice = yield* alice.client.chats
        .updateChat({ params: { id: chat.id }, payload: { title: "Nope" } })
        .pipe(Effect.flip);
      expect(renameByAlice._tag).toBe("Forbidden");
      const renamed = yield* bob.client.chats.updateChat({
        params: { id: chat.id },
        payload: { title: "Renamed by bob" },
      });
      expect(renamed.title).toBe("Renamed by bob");
    }),
  ));

test("transferOwnership: once a chat is ownerless, any participant can claim it, but a non-participant still can't", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const dave = yield* registerAndLogin("dave", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      // While alice still owns it, bob (a mere participant) can't transfer
      // ownership.
      const forbidden = yield* bob.client.chats
        .transferOwnership({
          params: { id: chat.id },
          payload: { userId: bob.user.id },
        })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      // Simulate alice's account being deleted — createdBy goes to null
      // (see db/schema.ts), leaving the group ownerless.
      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db.delete(users).where(eq(users.id, alice.user.id)),
      ).pipe(Effect.orDie);

      // dave isn't a participant, so he still can't claim it.
      const notParticipant = yield* dave.client.chats
        .transferOwnership({
          params: { id: chat.id },
          payload: { userId: bob.user.id },
        })
        .pipe(Effect.flip);
      expect(notParticipant._tag).toBe("Forbidden");

      // But bob, a participant of the now-ownerless chat, can claim it —
      // once he's accepted it (it's a message request for him, issue #808).
      yield* bob.client.chats.acceptChatRequest({ params: { id: chat.id } });
      const claimed = yield* bob.client.chats.transferOwnership({
        params: { id: chat.id },
        payload: { userId: bob.user.id },
      });
      expect(claimed.createdBy).toBe(bob.user.id);
    }),
  ));

// --- Per-chat roles (issue #220) ---

test("group chat creation seeds the creator as owner and everyone else as member", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const byUserId = new Map(chat.participants.map((p) => [p.userId, p]));
      expect(byUserId.get(alice.user.id)?.role).toBe("owner");
      expect(byUserId.get(bob.user.id)?.role).toBe("member");
    }),
  ));

test("direct chat participants are always plain members", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      for (const p of chat.participants) expect(p.role).toBe("member");
    }),
  ));

test("updateParticipantRole: only the owner can promote/demote, and not the owner themselves", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      // A plain member can't promote anyone, including themselves.
      const memberAttempt = yield* bob.client.chats
        .updateParticipantRole({
          params: { id: chat.id, userId: bob.user.id },
          payload: { role: "admin" },
        })
        .pipe(Effect.flip);
      expect(memberAttempt._tag).toBe("Forbidden");

      // The owner promotes bob to admin.
      const promoted = yield* alice.client.chats.updateParticipantRole({
        params: { id: chat.id, userId: bob.user.id },
        payload: { role: "admin" },
      });
      expect(
        promoted.participants.find((p) => p.userId === bob.user.id)?.role,
      ).toBe("admin");

      // An admin still can't promote/demote anyone else — only the owner can.
      const adminAttempt = yield* bob.client.chats
        .updateParticipantRole({
          params: { id: chat.id, userId: carol.user.id },
          payload: { role: "admin" },
        })
        .pipe(Effect.flip);
      expect(adminAttempt._tag).toBe("Forbidden");

      // The owner's own role can't be changed through this endpoint.
      const targetOwner = yield* alice.client.chats
        .updateParticipantRole({
          params: { id: chat.id, userId: alice.user.id },
          payload: { role: "member" },
        })
        .pipe(Effect.flip);
      expect(targetOwner._tag).toBe("InvalidChatRequest");

      // The owner demotes bob back to member.
      const demoted = yield* alice.client.chats.updateParticipantRole({
        params: { id: chat.id, userId: bob.user.id },
        payload: { role: "member" },
      });
      expect(
        demoted.participants.find((p) => p.userId === bob.user.id)?.role,
      ).toBe("member");
    }),
  ));

test("admins (not just the owner) can rename, add/remove participants, and delete any message", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const dave = yield* registerAndLogin("dave", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });
      yield* alice.client.chats.updateParticipantRole({
        params: { id: chat.id, userId: bob.user.id },
        payload: { role: "admin" },
      });

      const renamed = yield* bob.client.chats.updateChat({
        params: { id: chat.id },
        payload: { title: "Renamed by admin" },
      });
      expect(renamed.title).toBe("Renamed by admin");

      const added = yield* bob.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: [dave.user.id] },
      });
      expect(added.participants.map((p) => p.userId)).toContain(dave.user.id);

      // Alice is a stranger to Carol, so she accepts before posting.
      yield* carol.client.chats.acceptChatRequest({ params: { id: chat.id } });
      const message = yield* carol.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "hi all" },
      });
      // A plain member can't delete someone else's message...
      const memberDelete = yield* dave.client.chats
        .deleteMessage({ params: { id: chat.id, messageId: message.id } })
        .pipe(Effect.flip);
      expect(memberDelete._tag).toBe("Forbidden");
      // ...but the chat's admin can.
      yield* bob.client.chats.deleteMessage({
        params: { id: chat.id, messageId: message.id },
      });

      const removed = yield* bob.client.chats.removeParticipant({
        params: { id: chat.id, userId: dave.user.id },
      });
      expect(removed.participants.map((p) => p.userId)).not.toContain(
        dave.user.id,
      );
    }),
  ));

test("removeParticipant refuses to let a chat-level admin remove the owner", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      yield* alice.client.chats.updateParticipantRole({
        params: { id: chat.id, userId: bob.user.id },
        payload: { role: "admin" },
      });

      const result = yield* bob.client.chats
        .removeParticipant({ params: { id: chat.id, userId: alice.user.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");
    }),
  ));
