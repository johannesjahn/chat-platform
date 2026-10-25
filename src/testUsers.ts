import { HttpApiClient } from "effect/http-api";
import { Effect } from "effect";
import { ChatApi, type LoginResponse } from "./Api.ts";
import { googleSubFor, mintGoogleIdToken } from "./GoogleTestSigner.ts";

// Test users are created the way real ones are (issue #693): a Google ID
// token — minted with the test key the harness trusts (see testApi.ts) —
// sent to `POST /users/login/google`, then the username step at
// `POST /users/register/google`. There's no test-only signup path.

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

export { googleSubFor };

// A first Google sign-in for `username`'s Google account
// (`googleSubFor(username)`), through the username step, returning the new
// account's session.
export const signUpTestUser = (
  username: string,
  sub = googleSubFor(username),
) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const idToken = yield* Effect.promise(() => mintGoogleIdToken({ sub }));
    const first = yield* c.users.loginGoogle({ payload: { idToken } });
    if (!("needsUsername" in first))
      return yield* Effect.die(
        new Error(`Google account ${sub} is already registered`),
      );
    const session: LoginResponse = yield* c.users.registerGoogle({
      payload: { pendingToken: first.pendingToken, username },
    });
    return { ...session, sub };
  }).pipe(Effect.orDie);

// A returning Google sign-in — a fresh session for an account created by
// `signUpTestUser`, e.g. after its role changed (the role is baked into the
// access token at sign time).
export const signInTestUser = (
  username: string,
  sub = googleSubFor(username),
) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const idToken = yield* Effect.promise(() => mintGoogleIdToken({ sub }));
    const result = yield* c.users.loginGoogle({ payload: { idToken } });
    if ("needsUsername" in result)
      return yield* Effect.die(
        new Error(`Google account ${sub} has no account yet`),
      );
    return result;
  }).pipe(Effect.orDie);

// A freshly minted ID token for `username`'s Google account — what a Google
// account re-confirms an irreversible action (deleting itself) with.
export const googleIdTokenFor = (username: string) =>
  Effect.promise(() => mintGoogleIdToken({ sub: googleSubFor(username) }));
