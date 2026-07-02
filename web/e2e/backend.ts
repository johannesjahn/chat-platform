import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, () => {
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

async function waitUntilReady(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Backend isn't accepting connections yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend at ${url} did not become ready in time`);
}

export type TestBackend = {
  apiUrl: string;
  stop: () => Promise<void>;
};

// Boots a dedicated backend process on its own port, backed by its own
// SQLite file in a fresh temp dir. Each e2e test gets one of these instead
// of sharing a single backend/db across the whole run — the `/posts/all`
// feed isn't scoped per user, so a shared db let one test's seeded posts
// shift another test's exact-count assertions.
export async function startTestBackend(): Promise<TestBackend> {
  const port = await getFreePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "chat-platform-e2e-"));
  const dbPath = path.join(dataDir, "test.db");

  const child: ChildProcess = spawn("bun", ["run", "start"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-test-secret",
    },
    stdio: "ignore",
  });

  const apiUrl = `http://localhost:${port}`;
  try {
    await waitUntilReady(`${apiUrl}/docs`);
  } catch (error) {
    child.kill();
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    apiUrl,
    stop: async () => {
      child.kill();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
