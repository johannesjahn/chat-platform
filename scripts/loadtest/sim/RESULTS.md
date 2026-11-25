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

## 0.42.0 against the release before it (2026-11-25)

`c5ef0e7` (0.42.0) against `5d3a246` (`main` just before #944), alternating
on the same machine: 10k sockets, 4 backends, Postgres 19 capped at 4 CPUs,
Redis 8.12, each run on a fresh copy of its seeded database (10k users for
the 10k row, 100k users otherwise). Medians of 3 runs (2 at 10k) over the
steady state, except the per-endpoint p50s, which include the ramp. 0 errors,
0 drops, 0 missing echoes, generator lag at most 3 ms.

| Load                   | Metric                    |         Before |         0.42.0 |
| ---------------------- | ------------------------- | -------------: | -------------: |
| 10k, 1× rate           | p50 / p95                 |   3.6 / 7.3 ms |   3.6 / 7.1 ms |
| 40k-equivalent (`× 4`) | p50 / p95                 | 14.9 / 30.9 ms | 14.1 / 28.7 ms |
| 40k-equivalent (`× 4`) | Database time per request |       0.312 ms |       0.301 ms |
| 60k-equivalent (`× 6`) | p50 / p95                 |  50.3 / 102 ms |   43.5 / 88 ms |
| 60k-equivalent (`× 6`) | Message send p50          |          58 ms |          50 ms |
| 60k-equivalent (`× 6`) | Mark-as-read p50          |          78 ms |          64 ms |
| 60k-equivalent (`× 6`) | Postgres CPU              |          359 % |          343 % |

- **Same at normal load, about 14 % faster near saturation.** The likely
  cause is that 0.42.0 no longer writes `message_reads` (mark-as-read gained
  most), but the changes weren't measured separately. Near saturation, small
  savings cut queueing.
- **The ceiling is about the same**: at 60k-equivalent the backends still use
  ~1.05 cores each. The 100k-user database is no smaller (2.34 GB, was
  2.26 GB).
- **Seed layout is a confounder.** `seed.ts` ordered messages only by a
  timestamp every chat shares, so the order on disk was arbitrary: neighbouring
  rows were ~300 chats apart in one seed and ~89,000 in the other, which made
  the 0.42.0 unread-count query look slower on an identical plan. It now
  breaks ties, so the numbers below, from the old seed, aren't directly
  comparable with these.
- **One unexplained stall.** In a discarded first round on the old seed, one
  60k-equivalent run on 0.42.0 stalled for about 30 s as the last users connected,
  then recovered. It didn't recur in the three reruns above, and Postgres
  logged no errors. A rare problem under overload isn't ruled out.

## Capacity projection (2026-11-17)

Same machine and setup as below, on `main` at v0.41.5 with #865 (Redis
outage tolerance) in: the 100k-user database, 4 backends, Postgres capped
at 4 CPUs. 0 errors and generator lag under 10 ms in every run quoted.

| Run                              | Sockets | Requests/s | p50 / p95       | Backend cores (each) | Postgres | Verdict                       |
| -------------------------------- | ------: | ---------: | --------------- | -------------------- | -------: | ----------------------------- |
| 10k, 1× rate                     |  10,000 |     ~1,000 | 3.8 / 7.9 ms    | 0.26                 |     49 % | OK                            |
| 15k, 1× rate                     |  15,000 |     ~1,500 | 5.1 / 11.6 ms   | 0.42                 |     90 % | OK, still linear              |
| 40k-equivalent (`× 4`)           |  10,000 |     ~3,700 | 18 / 36 ms      | 0.91                 |    273 % | OK, near the knee             |
| 60k-equivalent (`× 6`)           |  10,000 |     ~5,200 | 60 / 115–147 ms | 1.03 (saturated)     |    359 % | Saturated; latency is queuing |
| 10k idle (every action rate `0`) |  10,000 |          0 | —               | 0.03                 |      2 % | Open sockets are nearly free  |

**This rig tops out at ~45–50k concurrent users** (4 single-core pods + a
4-CPU Postgres, both saturating together). Unit costs:

- ~0.1 requests/s per online user, linear from 10k to 15k real sockets.
- Backend: ~9–11k users per busy core; RSS ~200 MB plus ~80–120 KB per
  socket under load (~55 KB idle).
- Postgres: ~15k users per CPU, ~8.7 statements per request. Top costs are
  the message insert (14 %) and the `message_reads` insert (7.5 %); search
  is ~10 % of DB time from under 1 % of requests.
- Redis: ~20 % of one core even at saturation.

**Projected for the chart**, planning each tier at ~70 % utilisation:

| Setup                                                           | Binds on                                                                 | Max concurrent users |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------: |
| Chart defaults (2 pods at 500m / 512Mi, 1-CPU Postgres, no HPA) | Pod CPU and the 512Mi limit, about equally                               |                ~6–7k |
| HPA to `maxReplicas` 10, same sizes                             | The 1-CPU Postgres; 10 pods × `dbPoolMax` 10 also fill `max_connections` |              ~10–15k |
| ~16 pods at 1 core / 1.5Gi, 16-vCPU Postgres, PgBouncer         | Balanced                                                                 |                ~100k |
| Beyond                                                          | The single write primary (every send is a write)                         |    ~150–200k ceiling |

Cloud vCPUs are often slower than these cores: budget 1.5–2× the cores per
tier. Tiers above 15k use `--rate-multiplier`, since one macOS loopback
client runs out of ephemeral ports (`EADDRNOTAVAIL`) at ~16k sockets;
idle sockets being nearly free and per-user cost staying linear to 15k real
sockets is what makes that extrapolation reasonable.

**Two simulator pitfalls found on the way.** Backends used to be picked by
`id % targets`, so with `--population` 10× `--users` (a stride of 10) only
2 of 4 backends got any traffic; it's hashed now. And a strided population
puts no one's chat partners online (the seeded graph links each user to
ids +1/+7/+31/+101 and 10-wide groups), which silently drops all
recipient-side load: `chat_updated` events equal sends. Every run above uses
consecutive users (`--population` = `--users`), as the runs below did.

## Re-run after the fixes (2026-11-16)

Same machine, setup, seeds and simulator as below, on `main` at v0.41.5 plus
#862 (chat list patched from `message_created`) and #863 (active users from
`users.last_active_at`), i.e. with every fix from #850–#863 in. The client
behaviour the simulator replays is today's: no feed refetch (a "New posts"
pill), post reactions batched to viewers, unread counts and chat previews
patched from events.

| Run                            | Sockets | Backends | p50 / p95 (steady) | Throughput | Backend CPU (each) | Postgres | Verdict                                                    |
| ------------------------------ | ------: | -------: | ------------------ | ---------: | ------------------ | -------: | ---------------------------------------------------------- |
| 1k, default mix                |   1,000 |        1 | 5 ms / 10 ms       |   ~100 r/s | 0.27               |      5 % | OK (was 600 r/s, 87 % feed refetches)                      |
| 10k, default mix               |  10,000 |        1 | 3.5 ms / 8 ms      | ~1,000 r/s | 0.6, ~1 GB RSS     |     44 % | **OK** (was a 14 s collapse)                               |
| 10k, default mix               |  10,000 |        4 | 4 ms / 8.7 ms      | ~1,000 r/s | 0.27–0.29, ~430 MB |     70 % | **OK**, and now spreads across pods (was a 20 s collapse)  |
| 100k-equivalent¹, default mix  |  10,000 |        4 | 1.0 s / 1.2 s      | ~5,800 r/s | 1.03 (saturated)   |   ~380 % | Pods and Postgres both at their limit; latency is queueing |
| 100k-equivalent¹, pure chat    |  10,000 |        4 | 0.85 s / 1.0 s     | ~5,700 r/s | 1.04 (saturated)   |   ~360 % | Same; `main` without #862: 1.86 s p50, 22 % `GET /chats`   |
| 10k, one pod drained (SIGTERM) |  10,000 |        4 | p95 ≤ 11.6 ms      |          — | —                  |        — | No visible blip (was 2.05 s; #836)                         |

¹ As below: the 100k-user database (4.2M messages), 10k sockets at
`--rate-multiplier 10`. Chat fan-out is per message to its chat's
participants, so this does reproduce 100k users' chat frames; only global
events (`feed_head`, presence snapshots) are under-represented.

What the numbers say now:

- **Nothing grows quadratically any more.** Requests are ~0.1/s per online
  user (1,000 r/s at 10k), linear, and 0 errors / 0 missing echoes in every
  run. 10k users fit on one pod at 0.6 cores; on four they spread evenly
  (~1.1 cores in total — the Redis routing costs ~1.7× a single process's
  CPU, a fixed factor, not a growing one).
- **At 100k-equivalent both tiers saturate together** at ~5.8k r/s on four
  pods (~1.45k r/s per pod-core) and a 4-CPU Postgres (~1.5k r/s per CPU,
  ~9 statements per request). p50 ≈ 1 s is time queued at the ingress
  stand-in (`queueWait p99` 1.1 s), not slow queries: this is the
  throughput ceiling of this hardware, not a collapse.
- **Same hardware, more real work.** Against `main` without #862, the pure
  chat run spent 1.2k r/s on chat-list refetches and got 141k messages
  through at p50 1.86 s; with it, 182k messages (+28 %) at p50 0.85 s.
- **Redis has headroom.** At the 100k-equivalent rate: ~20 % of one core,
  ~36–53k ops/s, ~6 MB/s out; most of its time is the presence and user
  directory Lua scripts (`EVAL`, 8 µs/call). Redis is a single point of
  failure (#832), not a capacity limit, at this scale.
- **Background jobs are flat.** The active-users count takes 13 ms for all
  three windows on 4.2M messages (was ~480 ms per window), once per hour
  cluster-wide (#831).

**100k, projected from these unit costs:** ~10k requests/s, so ~7 cores of
backend fully busy. At the chart's 500m CPU limit per pod that's ~14 pods
busy and ~20 with headroom, above the HPA's default `maxReplicas` of 10
(`backend.autoscaling`, #838): raise the limit to a core (~10 pods) and/or
`maxReplicas`. Postgres needs ~7 CPUs, far beyond the chart's single 1-CPU
instance, and 10+ pods × `dbPoolMax` 10 exceed `max_connections` 100, so
PgBouncer or a higher limit (`postgres.maxConnections`, #851). Memory (10+
pods × ~600 MB plus Postgres) no longer fits the single 8 Gi node. What's
left that adding pods can't fix is the single Postgres primary (every send
is a write) and the single Redis (#832).

**Redis outage (#832).** 1k users on two pods, Redis stopped for 30 s
mid-run (longer than the ~11 s after which Bun's client used to give up for
good), then started again:

|                    | While Redis is down                            | After it's back                                                |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------- |
| before (`main`)    | every request hangs; 0 r/s; `/ready` times out | **100 % 500s until the pods restart**; `/ready` 503 throughout |
| with #832's change | 0 errors, p95 10–11 ms; `/ready` 200           | 0 errors; one `resync` per user, spread over 10 s              |

The original findings follow, unchanged, for reference.

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
