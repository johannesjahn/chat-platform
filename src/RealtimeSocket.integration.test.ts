import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

// This is the one test in the suite that runs the real thing: a real
// `bun run start` process, listening on a real port, with a real
// `WebSocket` client connecting to it. Everything else touching
// `RealtimeSocket.ts`/`Realtime.ts` (RealtimeSocket.test.ts, Realtime.test.ts)
// deliberately avoids this because `HttpServerRequest.upgrade` only works
// behind an actual `Bun.serve()` request — there's no way to exercise a
// successful upgrade through the in-process fake-fetch harness the other
// test files use. This is slower (spawns a subprocess, waits on real
// sockets) so it's kept to the one scenario that actually needs it: proving
// a chat event reaches only participants and a post event reaches everyone.

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    // Bind the loopback address explicitly — some sandboxes reject a
    // wildcard/dual-stack bind (the default when no host is given) even
    // though binding "127.0.0.1" specifically is allowed.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not determine a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitUntilReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not accepting connections yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

let child: ChildProcess;
let dataDir: string;
let apiUrl: string;
let wsUrl: string;

beforeAll(async () => {
  const port = await getFreePort();
  dataDir = mkdtempSync(path.join(tmpdir(), "chat-platform-ws-test-"));

  child = spawn("bun", ["run", "start"], {
    env: {
      ...process.env,
      PORT: String(port),
      // A PGlite data directory, not a single file — see Db.ts.
      DB_PATH: dataDir,
      JWT_SECRET: "realtime-integration-test-secret",
    },
    stdio: "ignore",
  });

  apiUrl = `http://localhost:${port}`;
  wsUrl = `ws://localhost:${port}`;
  await waitUntilReady(`${apiUrl}/docs`);
}, 20_000);

afterAll(() => {
  child?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function registerAndLogin(
  username: string,
): Promise<{ id: number; accessToken: string }> {
  const registerResponse = await fetch(`${apiUrl}/users/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  const user = (await registerResponse.json()) as { id: number };

  const loginResponse = await fetch(`${apiUrl}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  const { accessToken } = (await loginResponse.json()) as {
    accessToken: string;
  };
  return { id: user.id, accessToken };
}

function connect(accessToken: string): {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  ready: Promise<void>;
} {
  const socket = new WebSocket(`${wsUrl}/ws?token=${accessToken}`);
  const messages: Array<Record<string, unknown>> = [];
  socket.onmessage = (event) => {
    messages.push(JSON.parse(event.data as string));
  };
  const ready = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("socket error"));
  });
  return { socket, messages, ready };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition was not met in time");
}

test("a chat event reaches only the chat's participants, and a post event reaches every connected user", async () => {
  const alice = await registerAndLogin(`alice_${Date.now()}`);
  const bob = await registerAndLogin(`bob_${Date.now()}`);
  const carol = await registerAndLogin(`carol_${Date.now()}`);

  const aliceSocket = connect(alice.accessToken);
  const carolSocket = connect(carol.accessToken);
  await Promise.all([aliceSocket.ready, carolSocket.ready]);

  // Bob starts a direct chat with Alice and sends a message. Carol isn't a
  // participant in this chat at all.
  const chatResponse = await fetch(`${apiUrl}/chats/direct`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bob.accessToken}`,
    },
    body: JSON.stringify({ userId: alice.id }),
  });
  const chat = (await chatResponse.json()) as { id: number };

  await fetch(`${apiUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bob.accessToken}`,
    },
    body: JSON.stringify({ contentType: "text", content: "hi alice" }),
  });

  // Alice (a participant) gets notified — once for the chat being created,
  // once for the message.
  await waitFor(
    () =>
      aliceSocket.messages.filter(
        (m) => m.type === "chat_updated" && m.chatId === chat.id,
      ).length >= 2,
  );
  expect(
    aliceSocket.messages.filter(
      (m) => m.type === "chat_updated" && m.chatId === chat.id,
    ).length,
  ).toBeGreaterThanOrEqual(2);

  // Carol (not a participant) must never see a `chat_updated` for this chat,
  // no matter how long we wait — give the push a moment to have arrived if
  // it were (wrongly) going to.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(
    carolSocket.messages.some(
      (m) => m.type === "chat_updated" && m.chatId === chat.id,
    ),
  ).toBe(false);

  // Now Alice creates a post. Unlike chats, posts are public — Carol should
  // see this even though she has nothing to do with Alice's chat.
  const postResponse = await fetch(`${apiUrl}/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${alice.accessToken}`,
    },
    body: JSON.stringify({ contentType: "text", content: "hello feed" }),
  });
  const post = (await postResponse.json()) as { id: number };

  await waitFor(() =>
    carolSocket.messages.some(
      (m) => m.type === "post_changed" && m.postId === post.id,
    ),
  );
  expect(
    carolSocket.messages.some(
      (m) => m.type === "post_changed" && m.postId === post.id,
    ),
  ).toBe(true);

  aliceSocket.socket.close();
  carolSocket.socket.close();
}, 15_000);
