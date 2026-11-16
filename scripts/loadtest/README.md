# Load testing

k6 scripts that generate load against the backend's HTTP and WebSocket
surfaces, for manual/on-demand capacity checks — not a CI gate (see issue
#195). Two scenarios exist so far:

| Script         | Exercises                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http-crud.js` | Posts/comments/reactions and chats/messages REST endpoints under sustained concurrent load.                                                                   |
| `ws-fanout.js` | `chat_updated` realtime delivery latency to N concurrent `/ws` connections sharing one chat — the scenario that actually exercises `PubSub.ts`/Redis fan-out. |

Both are out-of-process k6 scripts (not `bun test` files) — they generate
load rather than assert unit behavior, per the tool's own docs.

## Install k6

k6 is a standalone binary, not an npm/bun package — install it separately:
<https://grafana.com/docs/k6/latest/set-up/install-k6/> (`brew install k6`,
or see the docs for Linux/Windows). Not added to `package.json` since it
isn't something `bun install` can manage.

## Run against docker-compose

The `ws-fanout.js` scenario needs a real Redis to say anything about
horizontally-scaled fan-out (the default `bun run dev` uses the in-memory
`PubSub`/`WsTicket` fallbacks, which only work for a single process — see
`src/PubSub.ts`/`src/WsTicket.ts`). Point both scripts at the
`docker-compose.yml` stack, which is closer to the Kubernetes deployment
topology than local dev mode:

```bash
cp .env.example .env   # fill in JWT_SECRET/POSTGRES_PASSWORD/REDIS_PASSWORD if not already
docker compose up --build -d

bun run loadtest:http
bun run loadtest:ws
```

Both default to `BASE_URL=http://localhost:3000` (docker-compose's exposed
port), overridable with `-e BASE_URL=...` / `-e WS_URL=...`.

**Don't point `BASE_URL` at a shared or production deployment.** `setup()`
seeds accounts with fixed, deterministic usernames (`loadtest-http-0`,
`loadtest-ws-0`, …) and a hardcoded shared password (`TEST_PASSWORD` in
`lib/api.js`) — fine against a disposable docker-compose/dev target, but
anyone who's read this file could log into those same accounts on any real
deployment they end up seeded on. Override `-e TEST_PASSWORD=...` if you
ever do need to run against a non-disposable target.

## Rate limits shape the defaults

The backend's auth rate limiters (`src/UsersHandler.ts`) are tuned for real
traffic, not a load generator running from a single source IP, and they
directly constrain how these scripts are written:

- **`/users/register` allows 10 attempts per source IP per minute and 50
  per hour.** Both
  scripts' `setup()` uses `loginOrRegister` (`lib/api.js`), which registers a
  fixed, deterministic set of accounts (`loadtest-http-0`, `loadtest-ws-0`,
  …) once and logs the same accounts back in on every later run — so only
  the _first_ run against a given backend spends any of that budget. Raising
  `USERS`/`WS_PARTICIPANTS` (see below) raises how many accounts a first run
  needs to register; keep it at or under 10 unless you've already seeded more
  accounts in an earlier run, or are running against a target where you've
  deliberately loosened this limit. Both also need at least 2 accounts —
  `createGroupChat` requires at least one participant besides the creator —
  and refuse to start below that.
- **`/users/login` allows 50 failed attempts per IP / 5 per account per
  15 minutes** (successful logins don't count). Only hit once per user in `setup()`, so this isn't a practical
  constraint at the default participant counts.
- **Engagement writes (reactions/comments/replies) are capped at 120 per user
  per minute** (`src/EngagementHandler.ts`), and the global per-IP limiter
  caps all requests at 1000/minute (`src/GlobalRateLimit.ts`).
  `http-crud.js` paces each VU with `sleep(SLEEP_SECONDS)` (default 3s)
  between iterations to stay comfortably under both: each iteration issues 6
  requests, 2 of them engagement writes, so a 3s floor caps any one VU at
  ~20 iterations/minute — at the default `VUS=USERS=5` (one VU per user),
  that's ≤40 engagement writes/minute/user (33% of the 120 cap) and ≤600
  requests/minute total (60% of the 1000 cap). Raising `VUS` and/or lowering
  `SLEEP_SECONDS` shrinks that margin — watch `http_req_failed` for 429s
  creeping in as a sign you've crossed one of these rather than found a real
  capacity ceiling.

## `http-crud.js`

```bash
bun run loadtest:http
# or directly, with overrides:
k6 run -e BASE_URL=http://localhost:3000 -e USERS=5 -e VUS=20 -e DURATION=2m -e SLEEP_SECONDS=3 scripts/loadtest/http-crud.js
```

`setup()` logs in `USERS` accounts (default 5) and creates one shared group
chat. Each VU repeatedly: creates a post, lists posts, reacts to its post,
comments on it, sends a chat message, and lists the chat's messages, then
sleeps `SLEEP_SECONDS` — picking one of the seeded accounts round-robin by VU
number. `VUS` (default = `USERS`) and `DURATION` (default `1m`) control the
load shape; see the rate-limits section above before raising `VUS` or
lowering `SLEEP_SECONDS` (default 3) much.

## `ws-fanout.js`

```bash
bun run loadtest:ws
# or directly, with overrides:
k6 run -e WS_PARTICIPANTS=5 -e ITERATIONS=20 -e EVENT_TIMEOUT_MS=5000 scripts/loadtest/ws-fanout.js
```

`setup()` logs in `WS_PARTICIPANTS` accounts (default 5) and creates one
shared group chat with all of them as participants. Each VU is one
participant, running `ITERATIONS` times: mint a `/ws` ticket, open the
socket, send a chat message, and record how long until its own
`chat_updated` event arrives back over that same socket (`createMessage`
fans the event out to every participant, including the sender — see
`ChatsHandler.ts` — so no separate correlation channel is needed). Latency
lands in the `ws_fanout_latency_ms` trend metric; a VU that doesn't see its
event within `EVENT_TIMEOUT_MS` counts against `ws_fanout_timeouts` instead
of hanging the run, and a socket that errors before that (a failed
connection/handshake) counts against `ws_fanout_errors` instead of silently
settling the iteration.

Since every VU publishes into the same chat concurrently, "the next
`chat_updated` a VU observes after its own send" occasionally belongs to
another VU's message queued just ahead of it rather than strictly its own —
under concurrent load that's actually a fair measure of end-to-end pipeline
latency (Redis publish → this instance's subscriber → this socket), not a
bug in the script.

## Surfacing results in Grafana

Point k6 at the same observability stack (`k8s/observability/`) the backend
already reports `/metrics` to, rather than only reading k6's own terminal
summary, so load-generator metrics (request rate, VU count, WS latency) show
up alongside backend metrics on shared dashboards during a run — e.g. k6's
[Prometheus remote-write
output](https://grafana.com/docs/k6/latest/results-output/real-time/prometheus-remote-write/):

```bash
k6 run --out experimental-prometheus-rw scripts/loadtest/http-crud.js
```

## `sim/` — realistic-user simulator

The two k6 scripts above hammer endpoints; they don't behave like users.
[`sim/simulate.ts`](sim/simulate.ts) does: every simulated user holds a real
`/ws` socket, runs a Poisson mix of chat/feed actions (per-minute rates in
`DEFAULT_ACTION_RATES_PER_MIN`), and **reacts to pushed events the way the
web client does** (`realtimeSocket.ts`/`chatSync.ts`/`postSync.ts`: a new
message in the open conversation fetches it and marks it read, a feed viewer
sometimes taps the "New posts" pill, every socket open self-heals...). At
scale those event-triggered requests were most of the load. Findings from
the first runs, and a re-run after fixing them, are in
[`sim/RESULTS.md`](sim/RESULTS.md).

```bash
# Throwaway Postgres (with pg_stat_statements) + Redis
docker run -d --name lt-pg -e POSTGRES_USER=lt -e POSTGRES_PASSWORD=lt -e POSTGRES_DB=lt \
  -p 127.0.0.1:55432:5432 --cpus=4 --memory=4g --shm-size=1g postgres:18-alpine \
  -c max_connections=200 -c shared_buffers=1GB -c shared_preload_libraries=pg_stat_statements
docker run -d --name lt-redis -p 127.0.0.1:56379:6379 redis:8.10.3-alpine
export DATABASE_URL=postgres://lt:lt@127.0.0.1:55432/lt REDIS_URL=redis://127.0.0.1:56379 \
  JWT_SECRET=loadtest-secret-loadtest-secret-loadtest-secret-0123
bun run db:migrate && docker exec lt-pg psql -U lt -d lt -c "create extension pg_stat_statements"

bun scripts/loadtest/sim/seed.ts --users 10000      # wipes the DB, seeds sim1..sim10000
scripts/loadtest/sim/servers.sh 4                    # 4 backends on :3100-3103, prints pids/targets
bun scripts/loadtest/sim/simulate.ts --users 10000 --targets <targets> --server-pids <pids> \
  --ramp 60 --duration 120 --out /tmp/10k.json
```

- **Seeding, not registering.** `seed.ts` writes users, a social graph (8
  direct chats + 2 groups of 10 each), message history and posts with
  `generate_series`; the simulator mints access tokens with `JWT_SECRET`.
  100k users take ~2 minutes; going through `/users/register` would take
  hours of argon2 and trip its per-IP limit.
- **Local backends only.** `--targets` must be loopback `http://` URLs. The
  simulator mints valid tokens for the seeded accounts and generates heavy
  load, so it refuses anything that could be a shared deployment.
- **One IP per user.** Backends run with `TRUST_PROXY=loopback` and each
  user sends its own `X-Forwarded-For`, so per-IP limits apply per user as
  they would behind the ingress.
- **An ingress stand-in.** Each worker sends through a bounded pool of
  keep-alive connections (`--inflight`, default 128), and latency includes
  time queued there, as it would at the ingress. Without it, a burst opens
  hundreds of TCP connections at once and macOS's 128-deep accept backlog
  resets them, which is a test artifact.
- **Knobs.** `--rate-multiplier N` makes each socket act like N users, to
  put more users' request load on the backend than one machine has sockets
  for (it does not scale fan-out). `--no-feed-refetch` and
  `--rates reactPost=0,createPost=0` switch off the paths that grow
  quadratically, to see what breaks next.
- **Trust the generator first.** `genLag99` (the generator's event-loop
  lag) must stay in single-digit ms; above that, the numbers are the load
  generator's. `bun --preload ./scripts/loadtest/sim/loop-lag.ts src/main.ts`
  logs a backend's own loop lag the same way.

## What's not here yet

Per issue #195's suggested prioritization, the rolling-deploy scenario
(sustained load while cycling replicas, to get real numbers behind #178's
expand-contract requirement) and any CI integration are deferred until
there's a first baseline from these two scenarios to act on.
