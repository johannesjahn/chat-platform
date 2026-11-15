# Load simulation results — 1k / 10k / 100k active users (2026-11-15)

Tracked in #839. Each finding below has its own issue (#827–#838).

Produced with `simulate.ts` + `seed.ts` (see [`../README.md`](../README.md)) at
v0.41.3. "Active user" = online, socket open, using the app at the
`DEFAULT_ACTION_RATES_PER_MIN` mix: ~1 message/min, 0.5 chat opens, 0.3 feed
loads, 0.2 post reactions, 0.03 posts (≈1 per 30 min online), plus searches,
comments and notifications. On top of that, each user replays the requests the
web client makes when socket events arrive.

**Environment, and how far to trust it.** Everything ran on one Apple M6
laptop (12 cores: 2 "super", 4 performance, 6 efficiency). Postgres 18 ran in
Docker, capped at 4 CPUs / 4 GB with `max_connections=200` and
`shared_buffers=1GB` (the chart runs stock config with a 1-CPU limit). Redis 8
ran in Docker, and the backends ran as native `bun src/main.ts` processes with
`DATABASE_URL`/`REDIS_URL`, so this is the multi-replica code path. Generator,
backends and DB shared the machine. Absolute numbers will differ on cloud
vCPUs, but the **ratios and growth rates are what matter**: who is called how
many times per event, and what grows with what. The generator's own
event-loop lag stayed under 10 ms in every run quoted here.

## What was measured

| Run                              | Sockets | Backends | p50 / p95 (all requests) | Throughput | Verdict                                             |
| -------------------------------- | ------: | -------: | ------------------------ | ---------: | --------------------------------------------------- |
| 1k, default mix                  |   1,000 |        1 | ~100 ms / 210 ms²        |   ~600 r/s | OK, 0 errors; Postgres idle                         |
| 10k, default mix                 |  10,000 |        1 | **14 s / 15 s**          | ~1,500 r/s | Collapses (1 core pinned writing ~200k frames/s)    |
| 10k, default mix                 |  10,000 |        4 | **20 s / 22 s**          | ~1,300 r/s | **Collapses the same way; 3 more pods didn't help** |
| 10k, no feed refetch / reactions |  10,000 |        1 | 5 ms / 35 ms             | ~1,900 r/s | OK at 0.85 cores, ~1 GB RSS                         |
| 100k-equivalent¹, chat + posts   |  10,000 |        4 | 3.5 s / 3.9 s            | ~5,200 r/s | Pods at 1 core, Postgres at 358 %                   |
| 100k-equivalent¹, pure chat      |  10,000 |        4 | 2.4 s / 2.8 s            | ~6,600 r/s | Postgres saturated (427 % of 4 CPUs)                |
| 10k, one pod killed + restarted  |  10,000 |        4 | p95 20 ms → 2.05 s       |          — | ~10 s cluster-wide degradation per pod restart      |

¹ 100k-user database (420k chats, 4.2M messages, 200k posts, 2.1 GB): 10k
sockets, each acting at 10× the per-user rate (`--rate-multiplier 10`). That
puts 100k users' request load on HTTP and Postgres. It does **not** reproduce
100k sockets' worth of fan-out, which is projected below from measured
per-unit costs.

² Dominated by `GET /posts` (87 % of requests, p50 127 ms): each new post
makes ~1,000 feed requests land at once. Every other endpoint: p50 2–6 ms.

Measured unit costs used for the projections:

- **Feed refetch storm.** Every `post_changed` "created" makes _every_ online
  client with the feed cached call `GET /posts?limit=10` (`pullNewPost`). At
  1k users, 62 posts produced 61k `GET /posts`, 87 % of all requests.
- **Broadcast frames.** `post_changed` and post `reaction_changed` go to
  every socket (`broadcastAll`). At 1k users, 459 reactions became 441k frames.
  A frame costs ~7 µs of `sendText` alone (25.7 % of a loaded backend's JS
  time in a CPU profile), and one process tops out at ~200k frames/s.
- **Backend.** ~0.6 ms CPU per request on the chat mix. Bun is
  single-threaded, so a pod saturates at ~1 core: ~1.5k requests/s plus that
  pod's share of fan-out. RSS is ~300–450 MB baseline plus ~50–100 KB per
  socket; 2.5k sockets under load measured 550–600 MB.
- **Postgres.** ~7.8 statements per HTTP request, saturating at ~6.6k
  requests/s (~52k statements/s) on 4 CPUs, roughly 1.6k requests/s per CPU.

## Projection per tier (current code)

Writing U for online users, with the default mix:

- `GET /posts` from refetches ≈ posts/s × U = U²/2,000 per second
- broadcast frames ≈ (posts + post reactions)/s × U ≈ U²/260 per second
- everything else ≈ 0.15 requests/s per user (linear)

| Tier | Linear requests |          Feed refetches |        Broadcast frames | What's needed / what breaks                                                         |
| ---: | --------------: | ----------------------: | ----------------------: | ----------------------------------------------------------------------------------- |
|   1k |         150 r/s |                 500 r/s |                 ~3.8k/s | 1 pod; fine (measured)                                                              |
|  10k |       1,500 r/s | **50k r/s** (~300k qps) |             **~380k/s** | Postgres can't serve the refetches; pods can't write the frames (measured collapse) |
| 100k |         15k r/s |   **5M r/s** (~30M qps) | **~38M/s** (~250 cores) | Not reachable by adding pods; needs the fan-out fixes first                         |

With the two quadratic paths fixed (no feed auto-refetch, and no
`broadcastAll` for posts/reactions), the linear part is what's left:

- **10k:** one pod handles it (measured).
- **100k:** ~15k requests/s, which needs ~10–12 pods at 1 core each and
  Postgres at ~10 CPUs. That means ~120 pool connections against a default
  `max_connections` of 100 (see below).

## Where horizontal scaling does not help (or makes it worse)

1. **One Postgres primary does all the work** (#830). There are no read replicas, no
   pooler, and every query from every pod lands on it. The feed refetch
   storm and the search scan below are DB work, so adding pods only adds
   clients. **Connection cap:** `drizzleBunSql(DATABASE_URL)` uses Bun.sql's
   default pool of 10 per process, which is hard-coded with no env override
   (measured: exactly 10 backends per instance). The chart's Postgres runs the
   default `max_connections=100`, so pods hit a wall at ~9 replicas, minus
   migrations and psql sessions.
2. **Quadratic fan-out** (#827, #828). Pods split the per-socket writes, but the total
   work is O(U²): 10× the users means 100× the frames and refetches. Adding
   pods helps linearly against quadratic growth. The refetches it triggers
   land on (1).
3. **The realtime bus is a broadcast** (#832). All events go to one Redis channel,
   `chat-platform:realtime`. Every pod receives, `JSON.parse`s and filters
   _every_ envelope, including ones for users it doesn't hold. So per-pod
   overhead tracks total cluster event volume, and Redis egress =
   publishes × pods. Presence is a single Redis hash
   (`chat-platform:presence:counts`), one key that Redis Cluster can't shard.
   Redis itself is a single, non-persistent, non-HA deployment.
4. **Background jobs run on every replica** (#831). `ActiveUsersMetrics` runs
   `SELECT DISTINCT sender_id FROM messages WHERE created_at >= …` with no
   index on `created_at`. That is a parallel seq scan over all messages:
   1.3 s each at 4.2M rows, 3 windows per run, hourly, ×replicas. It grows with
   message history, and each new pod adds another copy.
   `RefreshTokenCleanup` and `AttachmentCleanup` are likewise duplicated per
   pod.
5. **Per-pod caches get colder as you scale** (#833). `TokenVersionCache` holds 10k
   entries for 5 s, per pod. Round-robin means every pod sees every user.
   With 10k active users, 27 % of requests already missed (333k token
   lookups for 1.21M requests), and at 100k nearly every request pays an
   extra query. Adding pods doesn't raise the hit rate.
6. **Restarts hit the shared tier** (#836). Killing one pod holding 2.5k sockets
   pushed cluster-wide p95 from 20 ms to 2.05 s for ~10 s. Each reconnect costs
   a ticket, a `contactsOf` query, presence writes and fan-out, plus four
   self-heal refetches, all against the shared Postgres. A rolling deploy
   repeats that once per pod, and the waves get larger with more sockets per pod.
7. **A pod can't use more than one core** (#838), and the chart caps it at half.
   The backend limit is `cpu: 500m` / `memory: 512Mi`, below what one
   instance used under load (~1 core, 550–600 MB with 2.5k sockets). Expect
   CPU throttling, and OOM kills (which then cause reconnect waves) well
   before the numbers above. Postgres is limited to 1 CPU / 1 Gi and Redis to
   250m / 256 Mi. There's no HPA.

## Other hot spots found

- **Post search scans the table for rare terms** (#829). For a term that matches
  nothing, the tsvector arm runs `Index Scan Backward using posts_pkey`
  (filtering all 203k rows, 29 ms) instead of its GIN index; the trigram arm
  next to it uses its index in 0.4 ms. Post search was 0.5 % of requests and
  **22–26 % of all Postgres time** (25 ms mean, 142 ms max). It grows linearly
  with posts. Message search is fine (0.5 ms).
- **Unread counts are computed live** (#834). Every message to a chat that isn't on
  screen makes each online recipient refetch `GET /chats/unread-count` (a
  `COUNT` over unread messages) and, if the list is visible, `GET /chats`
  (~7 queries). Together these were the top two endpoints by volume
  (1.9k and 1.1k r/s at 100k-equivalent).
- **Comment counts are computed live on every feed page** (#835)
  (`count(*) … group by post_id`): 1 ms and growing as comments accumulate, 8 %
  of DB time.
- **The send path writes a lot per message.** It inserts into `messages`
  (maintaining two GIN indexes) and, on read, into `message_reads` one row per
  message (`INSERT … SELECT`), with FK `FOR KEY SHARE` checks: 685k of them in
  one run.
- **Hard kills leave ghost presence** (#837). Counts from a crashed pod aren't
  decremented; the 60 s field TTL clears them, but no "offline" event is ever
  sent, so contacts keep showing the user online until they reconnect.

## Suggested order of fixes

1. **Remove the O(U²) paths.**
   - Show a "N new posts" pill instead of auto-fetching on `post_changed`, or
     at least debounce it with random jitter.
   - Send post reactions and post changes only to a room of clients that have
     the post on screen. The post-room machinery for comments already exists.
   - Never `broadcastAll` per-item events.
2. **Postgres headroom.**
   - Make the pool size configurable and add PgBouncer (transaction mode).
   - Fix the post-search plan, e.g. `MATERIALIZED` CTE for the tsvector arm
     so it can't pick the PK-order scan.
   - Keep per-participant unread counters instead of `COUNT`, and cache
     comment counts.
   - Index `messages.created_at`, or make active-users incremental.
   - Run the hourly jobs on one replica (advisory lock).
3. **Realtime routing.** Route by recipient, e.g. per-pod channels via a
   user→pod map in Redis, so pods stop parsing everyone's events. Shard the
   presence hash. Make Redis HA.
4. **Deploy hygiene.**
   - Drain sockets gradually on SIGTERM (preStop), and decrement presence for
     them.
   - Scope the reconnect self-heal to what's actually stale (version-gap
     only) and add jitter.
   - Size pods to ≥1 CPU / ≥1.5 Gi with an HPA, and give Postgres real
     resources.
   - Raise `TokenVersionCache` capacity, or move the check to Redis.
