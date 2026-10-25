import { importJWK, SignJWT } from "jose";

// A stand-in for Google's ID-token signer (issue #693), shared by the backend
// unit tests and the e2e suite: they sign in through the very same
// `/users/login/google` + `/users/register/google` endpoints production
// uses, and only the key the tokens are checked against is swapped — the
// backend is pointed at `GOOGLE_TEST_PUBLIC_KEY` instead of Google's JWKS
// (see GoogleIdToken.ts, which refuses that override in production).
//
// The private key is committed on purpose. It signs nothing but test tokens,
// and a backend only trusts it when explicitly configured to.
const TEST_PRIVATE_JWK = {
  d: "AhHD3MqGMtYc0ZSDTXWs2sD-LLMrQpO1t_WzEE0FbpBLBUa_GJs42iFth9YmY3qlzvsd1YcvZP4zsJSZs3hz0cMRrQ_bDHrvy4rkGm4UKxibEKzuLvdE24aJcr8f5_YptUduggJ1yqAGQhSLRV2yeELh2YuXnHWFLds8OwIuYANLyl5At5rJio7O64L3Tg6g-6z2Y6VkVMwwZzKeVqEOBwyUvb7ZFMokJYn3BNnwzBd8lsQ3OAhfyBVtbqEDEGK0Ftx6i8qbIUw10gAt-h6OTwtcuDA05LIiA2Dlm2idQow-TnM8jNyu32HaEbBhX4hd8__dAYQkoWEoUfguLMBFcQ",
  dp: "BZ7szELWcUBreZBtSloYGUYAWea0HV-Owy5kmdFfDnOdNH61g1_rSDbOIJqa6ZH3kZYljfycR90q-7EbDXk99V4HUnZO2cGqMBm-X7s3wvFgj1Eiiws6Smeh4pNABx_bOH7r4Lt6G0iI7-LMFm6aFMTjMPZoD5208Tq6kpDT4yk",
  dq: "Seorr7gmFzWq8MGLz7xNcW_ZK16mJ5NGE2GOxiF5deSMbwK1txBKjYQpBBMm0vpdjfYIIt5G1axgc2RWcK3cRnEwyoNJEuI4AnQqDFzoOXODSI9YadngXhm7sC7hnKe_SSp2LvK6lUbhZ_F2NqJyna8Oc5wW3DHUwdjT1nS-9SE",
  e: "AQAB",
  kty: "RSA",
  n: "l38iAUuYDX0NSoxAs7PHLMAwXN-c-8Ng08ZIWWil54hZBCld_-MA5cA28KZ-_CZcV5s_Hfh2CC11nMV6ZJS-bq1rijY-EZpl0WulcN2CD94jikNItSUvrU40NVpzEHZ1Xz70GGEr1prgwfNF2hSAbWFSNvMyXWzzi7Cbt2agzwhI3FCnATCeaKeHlTc6QG6jI4jdusKVql2unWDpdhl2WAOTDCqf-coHQS-AnRkK9LRM_BIBFRN6TmOoHQ5a4etdJNU0Pc-tYoh7HEWitLKHxVudE0_rTYYPTISb6B8QoEmFLDGeHM94YEgHI-nEjMiRBYq__1f_dzCq8HE-BGgXKw",
  p: "yYP62C0xTtNJqSi7fNU1sDBnDv4Kp3JLcnABJl47Wo_quoa5JkrgFrMGFETVc4TrxWv-VpH2iyBUJYtOySTkW06FY_B_upxH8xs8JTHI2GMU0tz4Lr4WE1C0r35nZ5281AvQ5ZTYDdBqfgCOdOSfj9IPYkEfpy4DNkp5vUFS53s",
  q: "wHUP8l6RB5XBx3SAp19aeiUB9xan4dPVrPYn_RLFbgxunRHY1wgsZ2dsKLnKKCqkPfTfxIE6R0TrOpJbTcTv_oJ2tgSiOgHcNJr3zsM0Z1-so_sL6XwWIaqfs59vnC1HrEqbTX2gHAFJ2UIH2lV9CqfcY3S5roStl7Q5WzKaqBE",
  qi: "kOwCNSvsqc4ju0Nx3EoqKU7oyyKgSqFwuzSwoLY1URc_T_Y5mRmbOLT0awDwDUl6o2gYI69do1JKksKN3p-NayaHB59BAYmo1j0Wz9hO6BzGWawuBPRtyAZvKGh5riOJwdCHBe0oUZTcULpMf3kQXrmo6NEb-CxTZZ20aZgz3bM",
  kid: "chat-platform-test",
  alg: "RS256",
} as const;

// The public half — what `GOOGLE_TEST_PUBLIC_KEY` holds (as JSON).
export const GOOGLE_TEST_PUBLIC_KEY = JSON.stringify({
  kty: TEST_PRIVATE_JWK.kty,
  n: TEST_PRIVATE_JWK.n,
  e: TEST_PRIVATE_JWK.e,
  kid: TEST_PRIVATE_JWK.kid,
  alg: TEST_PRIVATE_JWK.alg,
  use: "sig",
});

// The OAuth client id test backends are configured with (`GOOGLE_CLIENT_ID`)
// — any string works, it only has to match the tokens' `aud`.
export const GOOGLE_TEST_CLIENT_ID =
  "chat-platform-test.apps.googleusercontent.com";

const privateKey = importJWK(TEST_PRIVATE_JWK, "RS256");

export type MintGoogleIdTokenOptions = {
  readonly sub: string;
  // Each defaults to what a genuine token for this app carries; override one
  // to produce a token the backend must reject.
  readonly aud?: string;
  readonly iss?: string;
  // Issue and expiry times, epoch seconds. Default to now and an hour from
  // now, like Google's.
  readonly iat?: number;
  readonly exp?: number;
};

// Signs an ID token shaped like Google's: RS256 under the test key's `kid`,
// carrying only the claims the backend reads (plus `iat`).
export const mintGoogleIdToken = async ({
  sub,
  aud = GOOGLE_TEST_CLIENT_ID,
  iss = "https://accounts.google.com",
  iat = Math.floor(Date.now() / 1000),
  exp = iat + 60 * 60,
}: MintGoogleIdTokenOptions): Promise<string> =>
  new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: TEST_PRIVATE_JWK.kid, typ: "JWT" })
    .setSubject(sub)
    .setAudience(aud)
    .setIssuer(iss)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(await privateKey);

// The Google account a test user signs in with, derived from the username so
// a test can sign the same account back in by name alone.
export const googleSubFor = (username: string): string =>
  `test-google-${username.toLowerCase()}`;

type Session = {
  readonly user: { readonly id: number; readonly username: string };
  readonly accessToken: string;
  readonly refreshToken: string;
};

const postJson = async (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `POST ${url} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
};

// Signs up over plain HTTP against a running backend configured with the test
// key — the first-sign-in flow a browser goes through, minus the browser.
// For callers outside the in-process harness (the realtime integration tests,
// the e2e fixtures, the load-test token helper). `headers` go on both
// requests (e.g. an `X-Forwarded-For` to land in its own rate-limit bucket).
export const signUpOverHttp = async <S extends Session = Session>(
  apiUrl: string,
  username: string,
  {
    sub = googleSubFor(username),
    headers,
  }: { sub?: string; headers?: Record<string, string> } = {},
): Promise<S> => {
  const idToken = await mintGoogleIdToken({ sub });
  const first = (await postJson(
    `${apiUrl}/users/login/google`,
    { idToken },
    headers,
  )) as { needsUsername?: true; pendingToken?: string };
  if (!first.needsUsername || !first.pendingToken) {
    throw new Error(`Google account ${sub} is already registered`);
  }
  return (await postJson(
    `${apiUrl}/users/register/google`,
    { pendingToken: first.pendingToken, username },
    headers,
  )) as S;
};

// A returning sign-in over plain HTTP, for an account `signUpOverHttp` made.
export const signInOverHttp = async <S extends Session = Session>(
  apiUrl: string,
  sub: string,
): Promise<S> => {
  const idToken = await mintGoogleIdToken({ sub });
  const session = (await postJson(`${apiUrl}/users/login/google`, {
    idToken,
  })) as S | { needsUsername: true };
  if ("needsUsername" in session) {
    throw new Error(`Google account ${sub} has no account yet`);
  }
  return session;
};
