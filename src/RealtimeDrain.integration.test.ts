import { afterAll, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

// Issue #836: on SIGTERM the server must close its `/ws` sockets itself —
// with SERVER_DRAINING_CLOSE_CODE, spread over WS_DRAIN_SECONDS — *before*
// the HTTP server stops, and refuse new upgrades meanwhile. Only a real
// process can show that ordering (the drain layer is released before the
// server's), so this spawns one, like RealtimeSocket.integration.test.ts —
// its own, since it kills it.

const DRAIN_SECONDS = 2;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
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

async function waitUntilReady(url: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

let child: ChildProcess | undefined;
let dataDir: string | undefined;

afterAll(() => {
  child?.kill("SIGKILL");
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("SIGTERM closes every socket with 4503 over the drain window, refuses new ones, then exits (issue #836)", async () => {
  const port = await getFreePort();
  dataDir = mkdtempSync(path.join(tmpdir(), "chat-platform-drain-test-"));
  // `bun src/main.ts`, not `bun run start`: the signal must reach the
  // server process itself.
  child = spawn("bun", ["src/main.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dataDir,
      JWT_SECRET: "realtime-drain-test-secret",
      REDIS_URL: "",
      TRUST_PROXY: "loopback",
      WS_DRAIN_SECONDS: String(DRAIN_SECONDS),
    },
    stdio: "ignore",
  });
  const exited = new Promise<number>((resolve) =>
    child!.on("exit", () => resolve(Date.now())),
  );
  const apiUrl = `http://localhost:${port}`;
  const wsUrl = `ws://localhost:${port}`;
  await waitUntilReady(`${apiUrl}/health`);

  const session = async (n: number) => {
    const username = `drain_${n}_${Date.now()}`;
    await fetch(`${apiUrl}/users/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `10.0.1.${n}`,
      },
      body: JSON.stringify({ username, password: "password123" }),
    });
    const login = await fetch(`${apiUrl}/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "password123" }),
    });
    return ((await login.json()) as { accessToken: string }).accessToken;
  };
  const ticket = async (accessToken: string) => {
    const response = await fetch(`${apiUrl}/realtime/ws-ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return ((await response.json()) as { ticket: string }).ticket;
  };

  const tokens = await Promise.all([1, 2, 3, 4].map(session));
  const closes: Array<Promise<{ code: number; at: number }>> = [];
  for (const token of tokens) {
    const socket = new WebSocket(`${wsUrl}/ws?ticket=${await ticket(token)}`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("socket failed to open"));
    });
    closes.push(
      new Promise((resolve) => {
        socket.onclose = (event) =>
          resolve({ code: event.code, at: Date.now() });
      }),
    );
  }

  const signalledAt = Date.now();
  child.kill("SIGTERM");

  // While draining, the server still answers, but sends new sockets away.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const late = new WebSocket(`${wsUrl}/ws?ticket=${await ticket(tokens[0]!)}`);
  const lateOpened = await new Promise<boolean>((resolve) => {
    late.onopen = () => resolve(true);
    late.onerror = () => resolve(false);
    late.onclose = () => resolve(false);
  });
  expect(lateOpened).toBe(false);

  const results = await Promise.all(closes);
  for (const { code } of results) expect(code).toBe(4503);
  // Within the window (plus slack), not all at the signal.
  for (const { at } of results) {
    expect(at - signalledAt).toBeLessThan((DRAIN_SECONDS + 1.5) * 1000);
  }

  // And the process then finishes shutting down on its own.
  const exitedAt = await exited;
  expect(exitedAt - signalledAt).toBeLessThan((DRAIN_SECONDS + 5) * 1000);
}, 30_000);
