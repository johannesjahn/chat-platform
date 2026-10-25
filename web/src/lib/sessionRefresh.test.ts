/// <reference types="bun" />
import { beforeEach, expect, test } from "bun:test";
import type { Session } from "./api";
import { REFRESH_LOCK, createSessionRefresher } from "./sessionRefresh";

// `stored` stands in for the localStorage every tab shares: a write by
// "another tab" is just an assignment here.
let stored: Session | null = null;
let presented: string[] = [];

// A minimal Web Locks stand-in: one exclusive lock per name, granted in
// request order.
const tails = new Map<string, Promise<unknown>>();
const locks = {
  request<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const run = (tails.get(name) ?? Promise.resolve()).then(fn);
    tails.set(
      name,
      run.catch(() => {}),
    );
    return run;
  },
} as Pick<LockManager, "request">;

const session = (refreshToken: string): Session => ({
  user: { id: 1, username: "ada" } as Session["user"],
  accessToken: `access-${refreshToken}`,
  refreshToken,
  authMethod: "google",
});

let refreshSession: (stale: Session) => Promise<Session | null>;

beforeEach(() => {
  stored = session("r0");
  presented = [];
  refreshSession = createSessionRefresher({
    apiUrl: "http://api",
    getSession: () => stored,
    setSession: (next) => {
      stored = next;
    },
    clearSession: () => {
      stored = null;
    },
    fetch: async (_url, init) => {
      const { refreshToken } = JSON.parse(String(init.body)) as {
        refreshToken: string;
      };
      presented.push(refreshToken);
      return Response.json({
        accessToken: `access-${refreshToken}+1`,
        refreshToken: `${refreshToken}+1`,
      });
    },
    locks,
  });
});

// Takes the refresh lock as another tab would, resolving once it's held;
// that tab keeps it until `release` runs its write to the shared session.
async function holdLockInOtherTab() {
  let release!: (write: () => void) => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => (acquired = resolve));
  const done = locks.request(
    REFRESH_LOCK,
    () =>
      new Promise<void>((resolve) => {
        release = (write) => {
          write();
          resolve();
        };
        acquired();
      }),
  );
  await held;
  return { release, done };
}

test("a refresh rotates the stored session", async () => {
  const next = await refreshSession(session("r0"));
  expect(presented).toEqual(["r0"]);
  expect(next?.refreshToken).toBe("r0+1");
  expect(stored?.refreshToken).toBe("r0+1");
});

test("concurrent refreshes in one tab send one request", async () => {
  const [a, b] = await Promise.all([
    refreshSession(session("r0")),
    refreshSession(session("r0")),
  ]);
  expect(presented).toEqual(["r0"]);
  expect(a).toBe(b);
});

test("a tab waiting on another tab's refresh uses its result instead of re-presenting the token (issue #650)", async () => {
  const otherTab = await holdLockInOtherTab();
  const ours = refreshSession(session("r0"));
  otherTab.release(() => {
    stored = session("r0+1");
  });
  await otherTab.done;

  expect((await ours)?.refreshToken).toBe("r0+1");
  expect(presented).toEqual([]);
});

test("a tab signed out while waiting for the lock doesn't refresh", async () => {
  const otherTab = await holdLockInOtherTab();
  const ours = refreshSession(session("r0"));
  otherTab.release(() => {
    stored = null;
  });
  await otherTab.done;

  expect(await ours).toBeNull();
  expect(presented).toEqual([]);
});

test("a rejected refresh clears the session", async () => {
  const rejecting = createSessionRefresher({
    apiUrl: "http://api",
    getSession: () => stored,
    setSession: () => {},
    clearSession: () => {
      stored = null;
    },
    fetch: async () => new Response(null, { status: 401 }),
    locks,
  });
  expect(await rejecting(session("r0"))).toBeNull();
  expect(stored).toBeNull();
});
