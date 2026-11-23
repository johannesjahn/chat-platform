import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { MAX_GROUP_PARTICIPANTS, MAX_INVITES_PER_CHAT } from "../Api.ts";
import { Db } from "../Db.ts";
import { chatInvites } from "../db/schema.ts";
import { makeTestRun } from "../testApi.ts";
import {
  insertDummyUsers,
  promoteToAdmin,
  registerAndLogin,
} from "./testKit.ts";

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

// --- A link stops working once its creator can't invite (issue #894) ---

type Session = Effect.Success<ReturnType<typeof registerAndLogin>>;

// Alice owns a group with Bob (an admin) and Dave; Bob and Alice each made a
// link.
const groupWithAdminLinks = Effect.gen(function* () {
  const alice = yield* registerAndLogin("alice", "pw-testpass");
  const bob = yield* registerAndLogin("bob", "pw-testpass");
  const dave = yield* registerAndLogin("dave", "pw-testpass");
  const chat = yield* alice.client.chats.createGroupChat({
    payload: { title: "Group", participantIds: [bob.user.id, dave.user.id] },
  });
  yield* alice.client.chats.updateParticipantRole({
    params: { id: chat.id, userId: bob.user.id },
    payload: { role: "admin" },
  });
  const bobsInvite = yield* bob.client.chats.createChatInvite({
    params: { id: chat.id },
    payload: {},
  });
  const alicesInvite = yield* alice.client.chats.createChatInvite({
    params: { id: chat.id },
    payload: {},
  });
  return { alice, bob, dave, chat, bobsInvite, alicesInvite };
});

const joinFails = (who: Session, code: string) =>
  who.client.chats.joinChatViaInvite({ params: { code } }).pipe(
    Effect.flip,
    Effect.map((e) => e.message),
  );

const revokedAtOf = (alice: Session, chatId: number, inviteId: number) =>
  alice.client.chats
    .listChatInvites({ params: { id: chatId } })
    .pipe(Effect.map((list) => list.find((i) => i.id === inviteId)?.revokedAt));

test("removing an admin revokes their links, so they can't rejoin through one", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, chat, bobsInvite, alicesInvite } =
        yield* groupWithAdminLinks;

      yield* alice.client.chats.removeParticipant({
        params: { id: chat.id, userId: bob.user.id },
      });

      expect(yield* joinFails(bob, bobsInvite.code)).toBe(
        "This invite has been revoked",
      );
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      expect(yield* joinFails(carol, bobsInvite.code)).toBe(
        "This invite has been revoked",
      );
      expect(yield* revokedAtOf(alice, chat.id, bobsInvite.id)).not.toBeNull();

      // A link from a manager who's still in the group keeps working.
      expect(yield* revokedAtOf(alice, chat.id, alicesInvite.id)).toBeNull();
      const joined = yield* carol.client.chats.joinChatViaInvite({
        params: { code: alicesInvite.code },
      });
      expect(joined.participants.some((p) => p.userId === carol.user.id)).toBe(
        true,
      );
    }),
  ));

test("leaving a group revokes the links you made in it", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, chat, bobsInvite, alicesInvite } =
        yield* groupWithAdminLinks;

      yield* bob.client.chats.leaveChat({ params: { id: chat.id } });

      expect(yield* joinFails(bob, bobsInvite.code)).toBe(
        "This invite has been revoked",
      );
      expect(yield* revokedAtOf(alice, chat.id, bobsInvite.id)).not.toBeNull();
      expect(yield* revokedAtOf(alice, chat.id, alicesInvite.id)).toBeNull();
    }),
  ));

test("demoting an admin to member revokes their links, and promoting them back doesn't restore them", () =>
  run(
    Effect.gen(function* () {
      const { alice, chat, bob, bobsInvite, alicesInvite } =
        yield* groupWithAdminLinks;

      yield* alice.client.chats.updateParticipantRole({
        params: { id: chat.id, userId: bob.user.id },
        payload: { role: "member" },
      });
      yield* alice.client.chats.updateParticipantRole({
        params: { id: chat.id, userId: bob.user.id },
        payload: { role: "admin" },
      });

      const carol = yield* registerAndLogin("carol", "pw-testpass");
      expect(yield* joinFails(carol, bobsInvite.code)).toBe(
        "This invite has been revoked",
      );
      expect(yield* revokedAtOf(alice, chat.id, alicesInvite.id)).toBeNull();
    }),
  ));

test("handing ownership over revokes the previous owner's links", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, chat, bobsInvite, alicesInvite } =
        yield* groupWithAdminLinks;

      // Alice is demoted to member by the transfer.
      yield* alice.client.chats.transferOwnership({
        params: { id: chat.id },
        payload: { userId: bob.user.id },
      });

      expect(yield* revokedAtOf(bob, chat.id, alicesInvite.id)).not.toBeNull();
      expect(yield* revokedAtOf(bob, chat.id, bobsInvite.id)).toBeNull();
    }),
  ));

test("joinChatViaInvite rejects a link whose creator no longer manages the chat, even if it was never revoked", () =>
  run(
    Effect.gen(function* () {
      const { chat, dave } = yield* groupWithAdminLinks;
      const db = yield* Db;

      // A link left over from before revocation on departure, made by
      // someone who's since become a plain member.
      yield* Effect.promise(() =>
        db.insert(chatInvites).values({
          chatId: chat.id,
          code: "legacy-member-link",
          createdBy: dave.user.id,
        }),
      );
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      expect(yield* joinFails(carol, "legacy-member-link")).toBe(
        "This invite has been revoked",
      );

      // A site admin can manage any chat, so their link holds without
      // being in it.
      const erin = yield* registerAndLogin("erin", "pw-testpass");
      const erinAdmin = yield* promoteToAdmin("erin", "pw-testpass");
      const sitesInvite = yield* erinAdmin.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });
      expect(sitesInvite.createdBy).toBe(erin.user.id);
      const joined = yield* carol.client.chats.joinChatViaInvite({
        params: { code: sitesInvite.code },
      });
      expect(joined.id).toBe(chat.id);
    }),
  ));

// --- Previewing an invite before joining (issue #899) ---

const previewFails = (who: Session, code: string) =>
  who.client.chats.previewChatInvite({ params: { code } }).pipe(Effect.flip);

test("previewChatInvite shows the group's name, picture, size and inviter — and nothing else", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Book club", participantIds: [bob.user.id] },
      });
      yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "secret-plans-for-friday" },
      });
      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: { maxUses: 1 },
      });

      const preview = yield* carol.client.chats.previewChatInvite({
        params: { code: invite.code },
      });
      expect(preview).toEqual({
        chatId: chat.id,
        title: "Book club",
        avatarVariants: null,
        memberCount: 2,
        alreadyMember: false,
        invitedBy: {
          id: alice.user.id,
          username: "alice",
          displayName: null,
          avatarUrl: null,
          avatarVariants: null,
        },
      });
      // No participant list, no messages: bob appears nowhere.
      const body = JSON.stringify(preview);
      expect(body).not.toContain("bob");
      expect(body).not.toContain("secret-plans-for-friday");

      // Looking doesn't redeem — the single use is still there for the join.
      const invites = yield* alice.client.chats.listChatInvites({
        params: { id: chat.id },
      });
      expect(invites.find((i) => i.id === invite.id)?.useCount).toBe(0);
      yield* carol.client.chats.joinChatViaInvite({
        params: { code: invite.code },
      });
    }),
  ));

test("previewChatInvite tells a member they're already in", () =>
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

      const preview = yield* bob.client.chats.previewChatInvite({
        params: { code: invite.code },
      });
      expect(preview.alreadyMember).toBe(true);
      expect(preview.chatId).toBe(chat.id);
    }),
  ));

test("previewChatInvite fails for a dead link exactly as joining would", () =>
  run(
    Effect.gen(function* () {
      const { alice, chat, dave, alicesInvite } = yield* groupWithAdminLinks;
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const erin = yield* registerAndLogin("erin", "pw-testpass");
      const db = yield* Db;

      const expectSameFailure = (code: string, tag: string, message: string) =>
        Effect.gen(function* () {
          const previewed = yield* previewFails(carol, code);
          const joined = yield* joinFails(carol, code);
          expect(previewed._tag).toBe(tag);
          expect(previewed.message).toBe(message);
          expect(joined).toBe(message);
        });

      // Unknown code.
      yield* expectSameFailure(
        "does-not-exist",
        "NotFound",
        "Invite not found",
      );

      // Revoked.
      const revoked = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });
      yield* alice.client.chats.revokeChatInvite({
        params: { id: chat.id, inviteId: revoked.id },
      });
      yield* expectSameFailure(
        revoked.code,
        "InvalidChatRequest",
        "This invite has been revoked",
      );

      // Made by someone who no longer manages the chat.
      yield* Effect.promise(() =>
        db.insert(chatInvites).values({
          chatId: chat.id,
          code: "legacy-member-link",
          createdBy: dave.user.id,
        }),
      );
      yield* expectSameFailure(
        "legacy-member-link",
        "InvalidChatRequest",
        "This invite has been revoked",
      );

      // Expired.
      const expiring = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: { expiresInHours: 1 },
      });
      yield* Effect.promise(() =>
        db
          .update(chatInvites)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(chatInvites.id, expiring.id)),
      );
      yield* expectSameFailure(
        expiring.code,
        "InvalidChatRequest",
        "This invite has expired",
      );

      // Used up.
      const singleUse = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: { maxUses: 1 },
      });
      yield* erin.client.chats.joinChatViaInvite({
        params: { code: singleUse.code },
      });
      yield* expectSameFailure(
        singleUse.code,
        "InvalidChatRequest",
        "This invite has reached its use limit",
      );

      // A block between the viewer and the link's creator, either way round.
      yield* carol.client.users.setBlock({
        params: { id: alice.user.id },
        payload: { type: "block" },
      });
      yield* expectSameFailure(
        alicesInvite.code,
        "Forbidden",
        "You can't join this chat because of a block",
      );
    }),
  ));

test("previewChatInvite says when the group is full", () =>
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
      const full = yield* previewFails(outsider, invite.code);
      expect(full._tag).toBe("InvalidChatRequest");
      expect(full.message).toBe(yield* joinFails(outsider, invite.code));

      // A member of the full group still gets the preview.
      const own = yield* alice.client.chats.previewChatInvite({
        params: { code: invite.code },
      });
      expect(own.memberCount).toBe(MAX_GROUP_PARTICIPANTS);
      expect(own.alreadyMember).toBe(true);
    }),
  ));

test("previewChatInvite is rate-limited per account", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      for (let i = 0; i < 60; i++) yield* previewFails(alice, `guess-${i}`);
      const limited = yield* previewFails(alice, "guess-60");
      expect(limited._tag).toBe("TooManyRequests");
      // Another account has its own budget.
      expect((yield* previewFails(bob, "guess-0"))._tag).toBe("NotFound");
    }),
  ));
