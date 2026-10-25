import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
import { PresenceAudience, PresenceAudienceLive } from "./PresenceAudience.ts";
import { makeTestRun } from "./testApi.ts";
import { signUpTestUser } from "./testUsers.ts";

const run = makeTestRun();

const registerAndLogin = (username: string) =>
  Effect.gen(function* () {
    const { user, accessToken } = yield* signUpTestUser(username);
    const client = yield* HttpApiClient.make(ChatApi, {
      baseUrl: "http://localhost",
      transformClient: (inner) =>
        HttpClient.mapRequest(
          inner,
          HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        ),
    });
    return { user, client };
  });

const contactsOf = (userId: number) =>
  Effect.gen(function* () {
    const audience = yield* PresenceAudience;
    return [...(yield* audience.contactsOf(userId))].sort((a, b) => a - b);
  }).pipe(Effect.provide(PresenceAudienceLive));

test("a user's presence audience is everyone they share a chat with, minus blocks either way", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      const dave = yield* registerAndLogin("dave");

      yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });

      expect(yield* contactsOf(alice.user.id)).toEqual([
        bob.user.id,
        carol.user.id,
      ]);
      expect(yield* contactsOf(bob.user.id)).toEqual([alice.user.id]);
      // Online somewhere, but in no chat with anyone.
      expect(yield* contactsOf(dave.user.id)).toEqual([]);

      // A block hides presence both ways, whoever placed it…
      yield* bob.client.users.setBlock({
        params: { id: alice.user.id },
        payload: { type: "block" },
      });
      expect(yield* contactsOf(alice.user.id)).toEqual([carol.user.id]);
      expect(yield* contactsOf(bob.user.id)).toEqual([]);

      // …but a mute doesn't, same as it never stops messaging.
      yield* carol.client.users.setBlock({
        params: { id: alice.user.id },
        payload: { type: "mute" },
      });
      expect(yield* contactsOf(alice.user.id)).toEqual([carol.user.id]);
    }),
  ));
