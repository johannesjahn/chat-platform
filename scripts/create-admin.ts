/**
 * Creates an admin account that signs in with a username and password, or
 * resets an existing admin's password (issue #693).
 *
 * Usage:  bun run scripts/create-admin.ts <username>           # create
 *         bun run scripts/create-admin.ts <username> --reset   # new password
 *
 * Everyone else signs in with Google; password accounts exist only for the
 * few admins without a Google account, and as the break-glass way in when
 * Google is unavailable. No HTTP endpoint creates them — this script is the
 * only way. A reset signs the admin out of every session.
 *
 * The password is prompted for (twice, hidden) on a terminal, or read from
 * the first line of stdin when it's piped — never taken as an argument,
 * where it would land in shell history and `ps`.
 *
 * Connects to the same database the app would: DATABASE_URL for a real
 * Postgres, otherwise PGlite at DB_PATH (migrated first). Stop a server
 * using the same PGlite DB_PATH first — PGlite is single-process.
 */
import {
  AdminAccountError,
  createAdminAccount,
  resetAdminPassword,
} from "../src/adminAccounts.ts";
import { connectDb } from "../src/Db.ts";

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const positional = args.filter((arg) => !arg.startsWith("--"));
const unknownFlags = args.filter(
  (arg) => arg.startsWith("--") && arg !== "--reset",
);
const username = positional[0];

if (!username || positional.length > 1 || unknownFlags.length > 0) {
  console.error("Usage: bun run scripts/create-admin.ts <username> [--reset]");
  process.exit(2);
}

// Reads one line from a terminal without echoing it.
const promptHidden = (question: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    stdin.on("data", onData);
  });

const readPassword = async (): Promise<string> => {
  if (!process.stdin.isTTY) {
    const input = await Bun.stdin.text();
    return input.split(/\r?\n/)[0] ?? "";
  }
  const password = await promptHidden("Password: ");
  const confirmation = await promptHidden("Confirm password: ");
  if (password !== confirmation) {
    throw new AdminAccountError("Passwords don't match");
  }
  return password;
};

try {
  const password = await readPassword();
  const { db, close } = await connectDb();
  try {
    const { id } = reset
      ? await resetAdminPassword(db, username, password)
      : await createAdminAccount(db, username, password);
    console.log(
      reset
        ? `[create-admin] Reset the password of admin "${username}" (id ${id}) and signed out its sessions.`
        : `[create-admin] Created admin "${username}" (id ${id}).`,
    );
  } finally {
    await close();
  }
  process.exit(0);
} catch (error) {
  console.error(
    `[create-admin] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
