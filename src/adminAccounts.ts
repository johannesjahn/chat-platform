import { and, eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  NewPassword,
  NewUsername,
  USERNAME_PATTERN_MESSAGE,
} from "./Api.ts";
import type { DrizzleDb } from "./Db.ts";
import { refreshTokens, users } from "./db/schema.ts";

// Admin password accounts (issue #693) — the break-glass sign-in for when
// Google is unavailable, and for admins without a Google account. No HTTP
// endpoint creates one or sets its password: only scripts/create-admin.ts
// does, through these. (The e2e suite seeds its admins through that same
// script.)

export class AdminAccountError extends Error {}

const isNewUsername = Schema.is(NewUsername);
const isNewPassword = Schema.is(NewPassword);

const checkCredentials = (username: string, password: string): void => {
  if (!isNewUsername(username))
    throw new AdminAccountError(
      `Invalid username: at least ${MIN_USERNAME_LENGTH} characters. ${USERNAME_PATTERN_MESSAGE}.`,
    );
  if (!isNewPassword(password))
    throw new AdminAccountError(
      `Invalid password: ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`,
    );
};

// Same algorithm as UsersHandler.ts's hashPassword, which verifies it.
const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, { algorithm: "argon2id" });

const byUsername = (username: string) =>
  eq(sql`lower(${users.username})`, username.toLowerCase());

// Creates a new admin that signs in with `username` and `password`.
export const createAdminAccount = async (
  db: DrizzleDb,
  username: string,
  password: string,
): Promise<{ readonly id: number }> => {
  checkCredentials(username, password);
  const passwordHash = await hashPassword(password);
  const rows = await db
    .insert(users)
    .values({ username, passwordHash, role: "admin" })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (!rows[0])
    throw new AdminAccountError(`Username "${username}" is already taken`);
  return rows[0];
};

// Sets a new password for an existing admin and signs every session of
// theirs out — revoking the refresh tokens and bumping `token_version`, as
// a password change does (running replicas notice within the token-version
// cache's few-second TTL).
export const resetAdminPassword = async (
  db: DrizzleDb,
  username: string,
  password: string,
): Promise<{ readonly id: number }> => {
  checkCredentials(username, password);
  const passwordHash = await hashPassword(password);
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(users)
      .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(and(byUsername(username), eq(users.role, "admin")))
      .returning({ id: users.id });
    const user = rows[0];
    if (user)
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));
    return user;
  });
  if (!updated)
    throw new AdminAccountError(`No admin account named "${username}"`);
  return updated;
};
