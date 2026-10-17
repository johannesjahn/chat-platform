// Seeds an admin account into a fresh PGlite data directory before the test
// backend boots on it (ios/scripts/test.sh). Registration only ever creates
// plain users — admins are promoted out-of-band in production — so this is
// the out-of-band step for the iOS UI tests, which then promote their own
// per-test users through `PATCH /users/:id/role` as this admin.
//
//   DB_PATH=<dir> bun ios/scripts/seed-admin.ts <username> <password>
//
// Run from the repo root (the migrations folder is `./drizzle`).
import { createPglite, runMigrations } from "../../src/Db.ts";

const [username, password] = process.argv.slice(2);
if (!process.env.DB_PATH || !username || !password) {
  console.error(
    "usage: DB_PATH=<dir> bun ios/scripts/seed-admin.ts <username> <password>",
  );
  process.exit(1);
}

await runMigrations();
const client = await createPglite();
const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
await client.query(
  "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')",
  [username, hash],
);
await client.close();
console.log(`Seeded admin ${username}`);
