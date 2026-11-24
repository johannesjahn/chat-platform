import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTestRun } from "../testApi.ts";
import { registerAndLogin } from "./testKit.ts";

// Group activity in the timeline (issue #900).

const run = makeTestRun();

type Account = Effect.Success<ReturnType<typeof registerAndLogin>>;

const account = (name: string) => registerAndLogin(name, "pw-testpass");

// What happened, as "type actor target detail".
const history = (viewer: Account, id: number) =>
  viewer.client.chats
    .listChatEvents({ params: { id } })
    .pipe(
      Effect.map((events) =>
        events.map((e) =>
          [e.type, e.actor?.name ?? "-", e.target?.name ?? "-", e.detail ?? ""]
            .join(" ")
            .trim(),
        ),
      ),
    );

const group = Effect.gen(function* () {
  const alice = yield* account("alice");
  const bob = yield* account("bob");
  const carol = yield* account("carol");
  const chat = yield* alice.client.chats.createGroupChat({
    payload: { title: "Trip", participantIds: [bob.user.id] },
  });
  return { alice, bob, carol, id: chat.id };
});

test("membership, title, role and owner changes are recorded once each", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, carol, id } = yield* group;
      expect(yield* history(bob, id)).toEqual([]);
      const chats = alice.client.chats;

      yield* chats.addParticipants({
        params: { id },
        payload: { participantIds: [carol.user.id] },
      });
      // Changes nothing, so it says nothing.
      yield* chats.addParticipants({
        params: { id },
        payload: { participantIds: [carol.user.id] },
      });
      yield* chats.updateChat({ params: { id }, payload: { title: "Rome" } });
      yield* chats.updateChat({ params: { id }, payload: { title: "Rome" } });
      const setRole = (role: "admin" | "member") =>
        chats.updateParticipantRole({
          params: { id, userId: bob.user.id },
          payload: { role },
        });
      yield* setRole("admin");
      yield* setRole("admin");
      yield* setRole("member");
      yield* chats.removeParticipant({
        params: { id, userId: carol.user.id },
      });
      yield* chats.deleteChatAvatar({ params: { id } });
      yield* chats.transferOwnership({
        params: { id },
        payload: { userId: bob.user.id },
      });

      expect(yield* history(bob, id)).toEqual([
        "member_added alice carol",
        "renamed alice - Rome",
        "admin_granted alice bob",
        "admin_revoked alice bob",
        "member_removed alice carol",
        "owner_changed alice bob",
      ]);
    }),
  ));

test("joining by invite, and an owner leaving, are recorded", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, carol, id } = yield* group;
      const invite = yield* alice.client.chats.createChatInvite({
        params: { id },
        payload: {},
      });
      yield* carol.client.chats.joinChatViaInvite({
        params: { code: invite.code },
      });
      yield* alice.client.chats.leaveChat({ params: { id } });
      expect(yield* history(bob, id)).toEqual([
        "member_joined carol -",
        "member_left alice -",
        "owner_changed - carol",
      ]);
    }),
  ));

test("an event follows the newest message, and is neither unread nor activity", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, id } = yield* group;
      yield* bob.client.chats.acceptChatRequest({ params: { id } });
      const message = yield* alice.client.chats.createMessage({
        params: { id },
        payload: { contentType: "text", content: "hi" },
      });
      yield* bob.client.chats.markRead({
        params: { id },
        payload: { messageId: message.id },
      });
      yield* bob.client.chats.updateChatPreferences({
        params: { id },
        payload: { archived: true },
      });
      yield* alice.client.chats.updateChat({
        params: { id },
        payload: { title: "Rome" },
      });
      const [event] = yield* bob.client.chats.listChatEvents({
        params: { id },
      });
      expect(event!.afterMessageId).toBe(message.id);
      const view = yield* bob.client.chats.getChat({ params: { id } });
      expect(view).toMatchObject({ unreadCount: 0, archived: true });
    }),
  ));

test("deleting an account keeps its events but not its name", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, carol, id } = yield* group;
      yield* alice.client.chats.addParticipants({
        params: { id },
        payload: { participantIds: [carol.user.id] },
      });
      yield* alice.client.users.deleteAccount({
        payload: { password: "pw-testpass" },
      });
      const [added, left, owner] = yield* history(bob, id);
      expect(added).toBe("member_added - carol");
      expect(left).toBe("member_left - -");
      expect(owner).toStartWith("owner_changed - ");
    }),
  ));

test("only participants see a group's events", () =>
  run(
    Effect.gen(function* () {
      const { carol, id } = yield* group;
      const error = yield* carol.client.chats
        .listChatEvents({ params: { id } })
        .pipe(Effect.flip);
      expect(error._tag).toBe("Forbidden");
    }),
  ));
