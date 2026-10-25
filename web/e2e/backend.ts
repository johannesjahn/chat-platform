import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GOOGLE_TEST_CLIENT_ID,
  GOOGLE_TEST_PUBLIC_KEY,
} from "../../src/GoogleTestSigner";

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

export type AdminAccount = { username: string; password: string };

// Creates an admin password account in `dataDir` the way an operator does —
// `scripts/create-admin.ts`, the password piped on stdin — before the
// backend that will own the (single-process) PGlite directory starts.
function createAdmin(dataDir: string, admin: AdminAccount): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["run", "scripts/create-admin.ts", admin.username],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DB_PATH: dataDir, DATABASE_URL: "" },
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`create-admin failed (${code}): ${stderr}`)),
    );
    child.stdin?.end(`${admin.password}\n`);
  });
}

// Boots a dedicated backend process on its own port, backed by its own
// PGlite data directory in a fresh temp dir. Each e2e test gets one of these
// instead of sharing a single backend/db across the whole run — the
// `GET /posts` feed isn't scoped per user, so a shared db let one test's
// seeded posts shift another test's exact-count assertions.
//
// `admins` are created first, through the real admin CLI (see `createAdmin`).
export async function startTestBackend(
  admins: readonly AdminAccount[] = [],
): Promise<TestBackend> {
  const port = await getFreePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "chat-platform-e2e-"));
  try {
    for (const admin of admins) await createAdmin(dataDir, admin);
  } catch (error) {
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  const child: ChildProcess = spawn("bun", ["run", "start"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      // A PGlite data directory, not a single file — see Db.ts.
      DB_PATH: dataDir,
      JWT_SECRET: "e2e-test-secret",
      // Google ID tokens are checked against the repo's test key, so the
      // suite signs in with tokens it mints itself (see fixtures.ts) — through
      // the same endpoints as production.
      GOOGLE_CLIENT_ID: GOOGLE_TEST_CLIENT_ID,
      GOOGLE_TEST_PUBLIC_KEY,
      // Single backend instance per e2e test — force the in-memory PubSub
      // fallback regardless of whatever REDIS_URL the host happens to have
      // set (see PubSub.ts).
      REDIS_URL: "",
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
