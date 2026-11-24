// Bulk-seeds a disposable Postgres with a realistic social graph for the
// user simulator (simulate.ts) — straight SQL with generate_series, since
// registering 100k accounts through the API would spend hours in argon2 and
// trip /users/register's per-IP limit (see ../README.md).
//
//   DATABASE_URL=postgres://... bun scripts/loadtest/sim/seed.ts --users 10000
//
// Wipes every table first. Never point it at anything but a throwaway DB.
//
// Shape, per user (N users, ids 1..N, usernames sim1..simN):
// - 8 direct chats (partners at fixed strides, so every pair is distinct),
// - 2 group chats of 10 (consecutive windows overlapping by 5),
// - MESSAGES_PER_CHAT messages of history in every chat, all read,
// - POSTS_PER_USER posts spread over the last week.
// That's 4.2N chats and ~22 distinct contacts per user — about what a
// moderately social account on a chat app looks like.
import { SQL } from "bun";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const N = arg("users", 1000);
const MESSAGES_PER_CHAT = arg("messages", 10);
const POSTS_PER_USER = arg("posts", 2);
const DIRECT_STRIDES = [1, 7, 31, 101]; // i <-> i+stride, so 8 partners each
const GROUP_SIZE = 10;
const GROUP_STEP = 5; // every user lands in GROUP_SIZE / GROUP_STEP = 2 groups

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (N < 2 * Math.max(...DIRECT_STRIDES) + GROUP_SIZE) {
  throw new Error(`--users must be at least ${2 * 101 + GROUP_SIZE}`);
}

const sql = new SQL(process.env.DATABASE_URL);
const step = async (label: string, run: () => Promise<unknown>) => {
  const t = performance.now();
  await run();
  console.log(
    `[seed] ${label} (${((performance.now() - t) / 1000).toFixed(1)}s)`,
  );
};

await step("truncate", () =>
  sql.unsafe(`
    DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables
               WHERE schemaname = 'public' AND tablename NOT LIKE '%drizzle%'
      LOOP EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE'; END LOOP;
    END $$`),
);

await step(`users (${N})`, () =>
  sql.unsafe(`
    INSERT INTO users (id, username, password_hash, display_name)
    SELECT i, 'sim' || i, 'not-a-real-hash', 'Sim User ' || i
    FROM generate_series(1, ${N}) i;
    SELECT setval('users_id_seq', ${N});`),
);

const directChats = DIRECT_STRIDES.length * N;
await step(`direct chats (${directChats})`, () =>
  sql.unsafe(`
    INSERT INTO chats (id, type, created_at, updated_at)
    SELECT id, 'direct', now() - interval '30 days', now() - interval '30 days'
    FROM generate_series(1, ${directChats}) id;
    INSERT INTO chat_participants (chat_id, user_id, joined_at, role)
    SELECT (s.k - 1) * ${N} + i, p.u, now() - interval '30 days', 'member'
    FROM generate_series(1, ${N}) i
    CROSS JOIN unnest(ARRAY[${DIRECT_STRIDES.join(",")}]) WITH ORDINALITY AS s(stride, k)
    CROSS JOIN LATERAL (VALUES (i), (((i - 1 + s.stride) % ${N}) + 1)) p(u);
    UPDATE chats c SET direct_user_low = p.low, direct_user_high = p.high
    FROM (SELECT chat_id, min(user_id) AS low, max(user_id) AS high
          FROM chat_participants GROUP BY chat_id) p
    WHERE p.chat_id = c.id;`),
);

const groups = Math.floor(N / GROUP_STEP);
await step(`group chats (${groups} x ${GROUP_SIZE})`, () =>
  sql.unsafe(`
    INSERT INTO chats (id, type, title, created_by, created_at, updated_at)
    SELECT ${directChats} + g + 1, 'group', 'Group ' || g, ((g * ${GROUP_STEP}) % ${N}) + 1,
           now() - interval '30 days', now() - interval '30 days'
    FROM generate_series(0, ${groups - 1}) g;
    INSERT INTO chat_participants (chat_id, user_id, joined_at, role)
    SELECT ${directChats} + g + 1, ((g * ${GROUP_STEP} + j) % ${N}) + 1,
           now() - interval '30 days', CASE WHEN j = 0 THEN 'owner' ELSE 'member' END
    FROM generate_series(0, ${groups - 1}) g, generate_series(0, ${GROUP_SIZE - 1}) j;
    SELECT setval('chats_id_seq', ${directChats + groups});`),
);

await step(`messages (${MESSAGES_PER_CHAT}/chat)`, () =>
  sql.unsafe(`
    INSERT INTO messages (chat_id, sender_id, content_type, content, created_at, updated_at)
    SELECT c.id, p.user_id, 'text',
           'history message ' || m || ' in chat ' || c.id || ' about ' ||
             (ARRAY['lunch','the game','deploys','weekend','music','a bug'])[1 + (c.id + m) % 6],
           now() - make_interval(mins => (${MESSAGES_PER_CHAT} - m) * 60),
           now() - make_interval(mins => (${MESSAGES_PER_CHAT} - m) * 60)
    FROM chats c
    CROSS JOIN generate_series(1, ${MESSAGES_PER_CHAT}) m
    CROSS JOIN LATERAL (
      SELECT user_id FROM chat_participants cp WHERE cp.chat_id = c.id
      ORDER BY user_id OFFSET (m % (CASE WHEN c.type = 'group' THEN ${GROUP_SIZE} ELSE 2 END)) LIMIT 1
    ) p
    ORDER BY 6;`),
);

await step("read watermarks + chat timestamps", () =>
  sql.unsafe(`
    WITH latest AS (SELECT chat_id, max(id) AS id, max(created_at) AS at FROM messages GROUP BY chat_id)
    UPDATE chat_participants cp SET last_read_message_id = latest.id
    FROM latest WHERE latest.chat_id = cp.chat_id;
    WITH latest AS (SELECT chat_id, max(created_at) AS at FROM messages GROUP BY chat_id)
    UPDATE chats c SET updated_at = latest.at FROM latest WHERE latest.chat_id = c.id;`),
);

await step(`posts (${POSTS_PER_USER}/user)`, () =>
  sql.unsafe(`
    INSERT INTO posts (author_id, content_type, content, created_at, updated_at)
    SELECT u, 'text', 'Seeded post ' || k || ' by sim' || u || ' on ' ||
             (ARRAY['coffee','typescript','cats','running','postgres','jazz'])[1 + (u + k) % 6],
           now() - make_interval(secs => (random() * 7 * 86400)::int),
           now()
    FROM generate_series(1, ${N}) u, generate_series(1, ${POSTS_PER_USER}) k
    ORDER BY 4;`),
);

await step("analyze", () => sql.unsafe("VACUUM ANALYZE"));

const [counts] = await sql.unsafe(`
  SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM chats) chats,
         (SELECT count(*) FROM chat_participants) participants,
         (SELECT count(*) FROM messages) messages, (SELECT count(*) FROM posts) posts,
         pg_size_pretty(pg_database_size(current_database())) size`);
console.log("[seed] done", counts);
await sql.close();
