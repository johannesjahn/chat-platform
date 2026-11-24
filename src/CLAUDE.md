# Backend (`src/`)

Paths below are relative to `src/` unless they start with `web/`.

## Database

- `Db.ts` picks PGlite (`DB_PATH` data directory, unset = in-memory) or,
  with `DATABASE_URL`, `drizzle-orm/bun-sql`. Every PGlite instance goes
  through `createPglite`, which registers `pg_trgm`.
- Each process's pool is `DB_POOL_MAX` connections (default 10, issue
  #830): replicas × `DB_POOL_MAX` must fit under Postgres's
  `max_connections`.
- **Database calls go through `dbQuery`**: it runs one query/transaction
  thunk, dies on failure, and is timed by `timedDbCall`
  (`db_query_duration_seconds` by `outcome` and the request's `method` and
  route _template_; `db_query_errors_total`). Label it only with those:
  never a raw path, a table or a user. Code that keeps a database failure
  as a typed error (`notifications.ts`, the forward's transaction,
  `serializableTransaction`) wraps its `Effect.tryPromise` in `timedDbCall`
  directly, passing `isAbort` for an expected abort so it isn't counted as
  an error.
- Schema changes: see `drizzle/CLAUDE.md`.

## Handler layout

The `chats`, `users` and `games` groups are split by area (issue #811).
`ChatsHandler.ts`, `UsersHandler.ts` and `GamesHandler.ts` only resolve
services and combine per-area handler maps from `chats/`, `users/` and
`games/` with `handlers.handleAll`, which fails to typecheck if an endpoint
is unhandled. Each `*Handlers.ts` returns its slice
`satisfies GroupHandlers<"group">` (`handlerKit.ts`, aliased per group next
to its `*Deps`).

- Put a new endpoint in the area it belongs to, and a helper next to its
  only caller until a second area needs it; then it moves to that group's
  shared modules (chats: see `chats/CLAUDE.md`; users: `userViews.ts`,
  `credentials.ts`; games: `lobbyStore.ts`, `settlement.ts`).
- Handler modules import only library modules, never each other. Code
  another group needs lives in one: `enforceRateLimit` (RateLimiter.ts),
  avatars.ts, `enforceUploadQuota` (attachments.ts), the `Post` view
  (posts.ts), the `User` view (users/userViews.ts). Helper modules never
  import handler modules.
- A block-either-way condition is `notBlockedEitherWay` (blocks.ts), never
  a hand-written `user_blocks` subquery (issue #810).
- Any query over `chat_participants` that introduces people or counts
  unread filters `request_pending = false` (see `chats/CLAUDE.md`).

## API schemas

`api/<area>.ts` holds an area's schemas, errors and endpoint group;
`Api.ts` re-exports them and assembles `ChatApi`, so code imports from
`Api.ts`. The `api/` modules build schemas at load time, so they must not
import each other in a cycle: shared pieces go in `api/common.ts`, errors in
`api/errors.ts`.

Two guards in `openapi.test.ts` (run after touching any endpoint):

- Every endpoint declaring `params`/`query`/`headers` must produce matching
  OpenAPI parameters.
- Length bounds: use `isMinLength` from `api/common.ts`. `Schema.isMinLength`
  documents `Math.ceil(n / 2)` (issue #761), and the test fails on a direct
  call; it also checks the spec's `minLength`/`maxLength` against the
  `MIN_*`/`MAX_*` constants.

## Search

`GET /search` and `/search/{users,posts,comments,messages}`: predicates in
`search.ts`, assembled in `SearchHandler.ts`. Two index-served branches: a
word/prefix branch over generated `tsvector` columns (GIN, `0017`) and a
substring branch (`ILIKE '%token%'`) over `pg_trgm` GIN indexes (`0023`).

- **Branches are a union of per-branch subqueries, never an `OR`**: under an
  `OR` with `ORDER BY id DESC LIMIT n` Postgres can use neither index. Every
  filter (content type, keyset cursor, blocked authors, chat
  participation, `request_pending`, `chatId`) lives _inside_ each arm; outside, it
  would shrink a page instead of pushing it deeper. See `matchingIds`.
- **Posts and comments arms are recent-first** (`recentFirstArm`, issue
  #829): the newest `SEARCH_RECENT_WINDOW` ids are filtered in id order, and
  older rows are reached through the index only when that didn't fill the
  page (a one-time `count(*) < limit` guard).
- **Content types in search predicates are SQL literals**, not parameters:
  under a prepared statement's generic plan, `content_type = $1` can't prove
  a partial index applies.
- Snippets are built in TypeScript (`buildSnippet`), not `ts_headline`, so a
  pure substring hit is highlighted too.
- Captions get their own union arms over partial expression indexes;
  filenames are never searched.

**Contacts below the 3-character floor.** User search needs 3 characters
(issue #48) so the directory can't be browsed. Below that, the client
suggests `GET /users/contacts` (`contactsOf` in users/directoryHandlers.ts,
issue #764), filtered by `web/src/lib/contactFilter.ts`. It returns only
people the caller shares an **accepted** chat with (pending requests on
either side don't count), minus blocks either way (mutes stay), newest chat
activity first, capped at `MAX_CONTACTS`. That rule is `contactOf`
(contacts.ts), shared with the presence audience.

## Attachments

**One row per attachment** (issue #896): anything that stores a client's
`attachmentId` writes through `withClaimedAttachment` (attachments.ts), which
404s on someone else's upload and 409s on one already on another post or
message. An edit that keeps its file skips both.

**Captions** (issue #765, `0037`): posts and messages carry an optional
`caption` beside an attachment.

- `content` stays the filename on attachment rows.
- `caption` counts only when `content_type = 'attachment'` (an old replica
  can re-type a row and leave the column), so readers go through `captionOf`
  (posts.ts) / `messageCaption` (chats/messageViews.ts).
- Edits: omitted keeps, `null` clears. A `caption` on a non-attachment is a 400.
- Captions notify `@mentions` on posts (not chats), are the notification
  excerpt, and are copied by a forward.

**Media input** (issues #732, #734): every ffmpeg/ffprobe call goes through
`runFfmpeg`/`runFfprobe` in `MediaInput.ts`, which whitelist protocol,
demuxers and decoders; `MediaInput.test.ts` fails on a call anywhere else.

- ffmpeg sees only server-generated file names: `processVideo` works on a
  copy, since the multipart temp file keeps the client's name.
- Point ffprobe only at files you wrote: it fails on any off-list stream,
  even an unselected one (it would reject every MP3 with album art), which
  is why `processAudio` doesn't probe the upload.
- FLAC and raw AAC stay rejected on purpose (not in
  `ALLOWED_ATTACHMENT_MIME_TYPES`, so they only arrive mislabelled); the 415
  says the format isn't supported.
- A new video/audio type in `ALLOWED_ATTACHMENT_MIME_TYPES` needs its
  demuxer and decoders checked in `MediaInput.ts`.

## Realtime

Events fan out through `PubSub.ts`: in-memory by default (one process), or
Redis Pub/Sub with `REDIS_URL` so replicas share events; see `Realtime.ts`.

- **Nothing per post goes to every socket** (issues #827, #828): that is
  O(U²) cluster-wide and collapsed at 10k users in the load simulation
  (`scripts/loadtest/sim/`). Every rendered post card watches its post
  (`watch_post`); edits/deletes go to viewers (`notifyPostViewers`). Post
  reactions are batched: one `post_reactions` frame per viewer per
  `PostReactionsInterval`. A new post is `announcePost`: one coalesced
  `feed_head` per `FeedHeadInterval` to `feed`-room sockets. Keep
  `broadcastAll` for rare, global events.
- **Channels per scope** (issue #832): a post's events and a named room's go
  on their own Redis channel, which an instance listens on only while a
  local socket shows that post or is in that room (`holdChannel`, released
  `RoomChannelLinger` after the last one leaves); user events go to the
  instances holding the recipients. Only `all` and `feed_post` go to every
  instance; give a new scope its own channel.
- **`chat_updated` carries an optional `change`** (`ChatChange`):
  `message_created` (with the `message` as non-senders see it, no
  `clientId`) or `read`. The client patches these and refetches on anything
  else, so keep `change` additive and send none for other mutations.
  Receipts stay one publish to every participant, so nobody sees a version
  gap.
- Own-write echoes publish _before_ the response with no actor; the client
  drops them (`web/src/lib/CLAUDE.md`).
- Named rooms (`subscribeRoom`/`notifyRoom`, `subscribe_room` over `/ws`)
  carry game traffic; see `games/CLAUDE.md`.

## Redis outages

Redis is a single instance (rate limits, `/ws` tickets, presence, the user
directory, cross-instance events), and the app keeps serving without it,
degraded, then self-correcting (issue #832).

- **Every Redis client comes from `supervisedRedis`**
  (`redisConnection.ts`): offline queue off (commands fail at once while
  down, instead of hanging requests), reconnects forever, `onConnect`
  listeners.
- **Each component falls back to instance-local state** through
  `redisFallback` (counted in `redis_fallbacks_total`, logged once per
  outage): rate limits count per pod; `/ws` tickets become HMAC-signed
  (`f1.` prefix, key from `JWT_SECRET`) and single-use per pod; a publish
  reaches the publishing pod's own subscribers; presence keeps
  `localCounts`; the directory's `locate` falls back to the shared channel.
- **On every connect** PubSub resubscribes, then runs `onReconnect`
  listeners: the auth cache drops (#833), every local socket gets a
  `resync` event and a fresh `presence_snapshot`, spread over
  `ResyncSpread`. Presence resyncs its share (`RESYNC_SCRIPT`); the
  directory re-asserts its claims.
- **Presence counts are bucketed** (`presenceCountsKey`, `userId %
PRESENCE_BUCKETS`); the Lua scripts derive the same key with
  `BUCKET_KEY_LUA`, so change both together. A change to what the shares
  count needs new registry keys (the `v2`), or new instances reap old ones'
  shares into the wrong place.
- **`/ready` checks only the database**: an outage hits every pod at once.
  `redis_connection_up` and the `BackendRedisUnreachable` alert report it.

`RedisOutage.integration.test.ts` cuts a real Redis through a TCP proxy;
`redisConnection.test.ts` boots without one.

## Background jobs

The hourly jobs (refresh-token cleanup, orphaned-attachment cleanup, the
`active_users` gauges) run **once per interval across all replicas** (issue
#831, `scheduledJobs.ts`). Each replica ticks every few minutes and runs a
job only if it claims it: one atomic upsert on `scheduled_jobs` (`0039`)
that moves `last_run_at` forward only when the interval has passed. No
session lock, so it works behind a transaction-mode PgBouncer. The
`active_users` winner stores its counts in `result` and every replica sets
its gauge from them, since Prometheus scrapes each replica. A new periodic
job goes through `forkTicker(runIfClaimed(name, every, job))`.

## Notifications

The bell and `/notifications` inbox (issue #317): `notifications` table
(`0027`), `api/notifications.ts`, read by `NotificationsHandler.ts`.

- Rows are written by the handler that performed the action, always through
  `createNotifications` (notifications.ts), which owns suppression (never
  yourself, never from someone you blocked/muted, never a type you turned
  off in `notification_preferences`, issue #900). It returns who it notified.
- **References, not copies**: a row stores ids; the excerpt is joined in at
  read time and target FKs cascade. Undoing a reaction retracts its
  notification.
- **Mentions parse like the renderer**: the `@username` regex mirrors
  `web/src/lib/mentions.ts`. Edits ping only newly added names. Chat
  messages create no mention notifications.
- Live delivery is an id-less `notifications_changed` to the recipient
  (`notifyUsers`); the client refetches.

To add a type: add it to `NotificationType` and the preferences (the
compiler lists the places, plus `NotificationTypesCard.tsx`), call `createNotifications`
from the handler that causes it, then on the client give it a sentence in
`web/src/components/NotificationRow.tsx`, an icon in `NOTIFICATION_ICONS`
(`web/src/components/notificationIcons.ts`), a target in
`notificationTarget` (`web/src/lib/notifications.ts`), and a preview in
`web/src/components/NotificationPreviewPane.tsx` (the `xl`+ pane a plain
click opens, issue #564).

## Admin stats

`GET /admin/stats` (admin-only, 403 otherwise; `AdminHandler.ts`, rendered
by `web/src/routes/admin.tsx`): lifetime totals, 1d/7d/30d activity, a
zero-filled daily timeline, live health.

- **Aggregates only, no per-user breakdown**: GDPR scoping, the same as the
  domain metrics in `Metrics.ts`. Active users are counted in Postgres so
  the id set never leaves it, from `users.last_active_at`
  (`countActiveUsersSince`, issue #831), which insert triggers on posts,
  comments, likes and messages move forward at most every 15 minutes
  (`0041`). A new content type that counts as activity needs the trigger
  too.
- **`health` is this process's counters**, from the same `effect/Metric`
  registry `/metrics` renders; Prometheus/Grafana is the deployment-wide
  view.
- Users created before `0025` all read as signed up when it ran.

## Tests

`bun run test` drives the `HttpApi` through an in-process web handler with a
deterministic `JWT_SECRET`, no server or network. One test file per area
(e.g. `users/*.test.ts`, helpers in each area's `testKit.ts`).

- A file calling `makeTestDbAccessor()` (`testDb.ts`) boots one in-memory
  PGlite for the file (migrated once), `TRUNCATE`d between tests. Keep tests
  within a file sequential: they share that instance. `--parallel` across
  files is safe.
- Every file provides `InMemoryPubSubLive`, except the integration tests
  that need real services and skip without them:
  `RealtimePubSub.integration.test.ts` (`REDIS_URL`) and
  `chats.postgres.integration.test.ts` (`TEST_DATABASE_URL`, a throwaway
  Postgres it truncates: only a real pool makes requests race through
  `serializableTransaction`, issue #654). CI provides both.
