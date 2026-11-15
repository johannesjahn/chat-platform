// Realistic-user simulator — many concurrent "active users", each holding a
// real /ws socket, doing a Poisson mix of chat/feed actions, *and reacting to
// pushed events the way the web client does* (the requests a socket event
// triggers are most of the load at scale, and a script that only fires REST
// calls never sees them). Pairs with seed.ts. See ../README.md.
//
//   bun scripts/loadtest/sim/simulate.ts --users 1000 --population 1000 \
//     --targets http://127.0.0.1:3000,http://127.0.0.1:3001 --duration 180
//
// Users are spread round-robin over --targets (what a load balancer does)
// and over --workers processes (one Bun process tops out well before the
// backend does). Each user gets its own X-Forwarded-For address, so the
// backend must run with TRUST_PROXY=loopback, as it would behind an ingress.
// Access tokens are minted locally with JWT_SECRET (same secret as the
// backend) for the seeded users sim1..simN.
//
// --rate-multiplier scales every user-initiated action rate, to put the
// request load of more users than this machine can hold sockets for on the
// backend. It does not scale fan-out (each event still reaches only the
// sockets that exist) — see the README for how the report accounts for that.
import { cpus } from "os";

type Config = {
  users: number;
  population: number;
  targets: string[];
  duration: number;
  ramp: number;
  workers: number;
  rateMultiplier: number;
  jwtSecret: string;
  firstUser: number;
  out: string | null;
  serverPids: number[];
  inflight: number;
  // Models a client that shows a "new posts" pill instead of fetching the
  // feed on every post_changed (see the README's fan-out section).
  feedRefetch: boolean;
  rates: Partial<Record<Action, number>>;
};

const argv = process.argv;
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1]!;
};

// Per-user action rates, per minute, for a user who is online and using the
// app (not a backgrounded tab). Chat-heavy, like the product: most activity
// is messaging; posting is rare, reading the feed is common.
const DEFAULT_ACTION_RATES_PER_MIN = {
  sendMessage: 1.0,
  typing: 0.6,
  openChat: 0.5,
  scrollFeed: 0.3,
  reactPost: 0.2,
  comment: 0.05,
  createPost: 0.03,
  search: 0.05,
  notifications: 0.1,
} as const;
type Action = keyof typeof DEFAULT_ACTION_RATES_PER_MIN;

// ---------------------------------------------------------------- histogram
// Log-bucketed (5% wide) so per-worker histograms merge exactly.
const BUCKET_RATIO = Math.log(1.05);
const bucketOf = (ms: number) =>
  Math.max(
    0,
    Math.min(399, Math.floor(Math.log(Math.max(ms, 0.1) * 10) / BUCKET_RATIO)),
  );
const msOf = (bucket: number) => Math.exp((bucket + 0.5) * BUCKET_RATIO) / 10;
type Hist = number[];
const newHist = (): Hist => new Array(400).fill(0);
const quantile = (h: Hist, q: number) => {
  const total = h.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let seen = 0;
  for (let i = 0; i < h.length; i++) {
    seen += h[i]!;
    if (seen >= q * total) return msOf(i);
  }
  return msOf(h.length - 1);
};

type EndpointStats = {
  count: number;
  errors: Record<string, number>;
  hist: Hist;
};
type Snapshot = {
  endpoints: Record<string, EndpointStats>;
  wsOpen: number;
  wsConnects: number;
  wsFailures: number;
  wsDrops: number;
  events: Record<string, number>;
  echo: Hist;
  echoCount: number;
  echoMissing: number;
  queueWait: Hist;
  loopLag: Hist;
};

const emptySnapshot = (): Snapshot => ({
  endpoints: {},
  wsOpen: 0,
  wsConnects: 0,
  wsFailures: 0,
  wsDrops: 0,
  events: {},
  echo: newHist(),
  echoCount: 0,
  echoMissing: 0,
  queueWait: newHist(),
  loopLag: newHist(),
});

const mergeInto = (into: Snapshot, from: Snapshot) => {
  for (const [name, e] of Object.entries(from.endpoints)) {
    const t = (into.endpoints[name] ??= {
      count: 0,
      errors: {},
      hist: newHist(),
    });
    t.count += e.count;
    for (const [k, v] of Object.entries(e.errors))
      t.errors[k] = (t.errors[k] ?? 0) + v;
    e.hist.forEach((v, i) => (t.hist[i]! += v));
  }
  into.wsOpen += from.wsOpen;
  into.wsConnects += from.wsConnects;
  into.wsFailures += from.wsFailures;
  into.wsDrops += from.wsDrops;
  for (const [k, v] of Object.entries(from.events))
    into.events[k] = (into.events[k] ?? 0) + v;
  from.echo.forEach((v, i) => (into.echo[i]! += v));
  into.echoCount += from.echoCount;
  into.echoMissing += from.echoMissing;
  from.queueWait.forEach((v, i) => (into.queueWait[i]! += v));
  from.loopLag.forEach((v, i) => (into.loopLag[i]! += v));
};

// The handful of response and event fields the simulator reads — loose on
// purpose: it only needs ids and cursors, not the full API types.
type Body = {
  id?: number;
  ticket?: string;
  chats?: Array<{ id: number }>;
  posts?: Array<{ id: number }>;
  messages?: Array<{ id: number }>;
  latestCursor?: string | null;
};
type SocketEvent = {
  type: string;
  change?: string;
  chatId?: number;
  postId?: number;
  senderId?: number;
};

// ---------------------------------------------------------------- worker
async function runWorker(config: Config, userIds: number[]) {
  let stats = emptySnapshot();
  let wsOpen = 0;
  const deadline = Date.now() + (config.ramp + config.duration) * 1000;

  // Event-loop lag: if this climbs, the generator — not the backend — is
  // the bottleneck, and latencies above it are not to be trusted.
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    stats.loopLag[bucketOf(Math.max(0, now - lastTick - 100))]!++;
    lastTick = now;
  }, 100);

  setInterval(() => {
    stats.wsOpen = wsOpen;
    process.stdout.write(JSON.stringify(stats) + "\n");
    stats = emptySnapshot();
  }, 2000);

  // A bounded pool of persistent connections per worker, standing in for
  // the ingress's upstream keep-alive pool: browsers connect to the ingress,
  // so a pod never sees thousands of fresh TCP handshakes at once (and
  // macOS's 128-deep accept backlog would reset them if it did). Latency is
  // measured from when the user issued the request, so time queued here —
  // as it would queue at the ingress — counts as user-perceived latency.
  let inflight = 0;
  const waiting: Array<() => void> = [];
  const acquire = () =>
    inflight < config.inflight
      ? (inflight++, Promise.resolve())
      : new Promise<void>((resolve) =>
          waiting.push(() => (inflight++, resolve())),
        );
  const release = () => {
    inflight--;
    waiting.shift()?.();
  };

  let loggedErrors = 0;
  const record = (name: string, ms: number, status: number | string) => {
    const e = (stats.endpoints[name] ??= {
      count: 0,
      errors: {},
      hist: newHist(),
    });
    e.count++;
    e.hist[bucketOf(ms)]!++;
    if (typeof status === "string" || status >= 400) {
      e.errors[String(status)] = (e.errors[String(status)] ?? 0) + 1;
    }
  };

  const mintToken = async (id: number) => {
    const b64 = (s: string | Uint8Array) =>
      Buffer.from(s).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64(
      JSON.stringify({
        sub: id,
        username: `sim${id}`,
        role: "user",
        type: "access",
        iat: now,
        exp: now + 6 * 3600,
        jti: crypto.randomUUID(),
        tokenVersion: 0,
      }),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(config.jwtSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${b64(new Uint8Array(sig))}`;
  };

  const ACTION_RATES_PER_MIN = {
    ...DEFAULT_ACTION_RATES_PER_MIN,
    ...config.rates,
  };
  const exp = (ratePerMin: number) =>
    (-Math.log(1 - Math.random()) / ratePerMin) * 60_000;
  const pick = <T>(xs: readonly T[]) =>
    xs[Math.floor(Math.random() * xs.length)]!;
  const totalRate =
    Object.values(ACTION_RATES_PER_MIN).reduce((a, b) => a + b, 0) *
    config.rateMultiplier;
  const actions = Object.entries(ACTION_RATES_PER_MIN) as Array<
    [Action, number]
  >;
  const pickAction = (): Action => {
    let r = Math.random() * (totalRate / config.rateMultiplier);
    for (const [a, w] of actions) if ((r -= w) <= 0) return a;
    return "sendMessage";
  };

  async function simulateUser(id: number, base: string, startDelay: number) {
    await Bun.sleep(startDelay);
    const token = await mintToken(id);
    const ip = `10.${(id >> 16) & 255}.${(id >> 8) & 255}.${id & 255}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    };

    const call = async (
      name: string,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Body | null> => {
      const queued = performance.now();
      await acquire();
      const start = performance.now();
      stats.queueWait[bucketOf(start - queued)]!++;
      try {
        const res = await fetch(base + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        record(name, performance.now() - queued, res.status);
        if (!res.ok) return null;
        return text ? JSON.parse(text) : null;
      } catch (error) {
        if (loggedErrors++ < 3)
          console.error(`[sim] ${name}: ${String(error)}`);
        record(
          name,
          performance.now() - queued,
          (error as Error).name || "error",
        );
        return null;
      } finally {
        release();
      }
    };

    // Collapses repeated invalidations of the same query into at most one
    // in flight plus one queued — kinder than React Query's default, which
    // cancels and restarts — so reaction counts here are a floor.
    const refetching = new Map<string, "running" | "again">();
    const refetch = (key: string, run: () => Promise<unknown>) => {
      const state = refetching.get(key);
      if (state) return void refetching.set(key, "again");
      refetching.set(key, "running");
      void (async () => {
        do {
          refetching.set(key, "running");
          await run();
        } while (refetching.get(key) === "again");
        refetching.delete(key);
      })();
    };

    let chatIds: number[] = [];
    let screen: "chats" | "feed" = Math.random() < 0.5 ? "chats" : "feed";
    let openChat: number | null = null;
    let latestInOpenChat = 0;
    let latestCursor: string | null = null; // useChatMessages' paging cursor
    let feedPostIds: number[] = [];
    const ownPosts = new Set<number>();
    const pendingEchoes = new Map<number, number[]>(); // chatId -> send start times

    const loadChats = async () => {
      const page = await call("GET /chats", "GET", "/chats");
      if (page?.chats) chatIds = page.chats.map((c) => c.id);
    };
    const loadFeed = async () => {
      const page = await call("GET /posts", "GET", "/posts?limit=10");
      if (page?.posts) feedPostIds = page.posts.map((p) => p.id);
    };
    const openConversation = async (chatId: number) => {
      screen = "chats";
      openChat = chatId;
      const [, page] = await Promise.all([
        call("GET /chats/:id", "GET", `/chats/${chatId}`),
        call(
          "GET /chats/:id/messages",
          "GET",
          `/chats/${chatId}/messages?limit=30`,
        ),
      ]);
      const ids: number[] = (page?.messages ?? []).map((m) => m.id);
      latestInOpenChat = ids.length ? Math.max(...ids) : 0;
      latestCursor = page?.latestCursor ?? null;
      if (latestInOpenChat) {
        await call("POST /chats/:id/read", "POST", `/chats/${chatId}/read`, {
          messageId: latestInOpenChat,
        });
      }
    };
    // What the web client refetches on every socket (re)open (issue #54).
    const selfHeal = () =>
      Promise.all([
        loadChats(),
        call("GET /chats/unread-count", "GET", "/chats/unread-count"),
        call(
          "GET /notifications/unread-count",
          "GET",
          "/notifications/unread-count",
        ),
        loadFeed(),
      ]);

    // Boot: what the app shell and its first route load.
    await Promise.all([
      call("GET /users/:id", "GET", `/users/${id}`),
      selfHeal(),
    ]);
    if (screen === "chats" && chatIds.length)
      await openConversation(pick(chatIds));

    let ws: WebSocket | null = null;
    let backoff = 1000;
    const connect = async () => {
      if (Date.now() > deadline) return;
      const ticket = await call(
        "POST /realtime/ws-ticket",
        "POST",
        "/realtime/ws-ticket",
      );
      if (!ticket?.ticket) {
        stats.wsFailures++;
        setTimeout(connect, backoff / 2 + Math.random() * (backoff / 2));
        backoff = Math.min(backoff * 2, 15_000);
        return;
      }
      const socket = new WebSocket(
        `${base.replace(/^http/, "ws")}/ws?ticket=${ticket.ticket}`,
        { headers: { "x-forwarded-for": ip } },
      );
      ws = socket;
      let opened = false;
      let ping: ReturnType<typeof setInterval> | undefined;
      socket.onopen = () => {
        opened = true;
        wsOpen++;
        stats.wsConnects++;
        backoff = 1000;
        ping = setInterval(() => socket.send("ping"), 30_000);
        void selfHeal();
      };
      socket.onmessage = (event) => onEvent(JSON.parse(String(event.data)));
      socket.onclose = () => {
        clearInterval(ping);
        if (opened) {
          wsOpen--;
          if (Date.now() < deadline) stats.wsDrops++;
        } else stats.wsFailures++;
        if (Date.now() < deadline) {
          setTimeout(connect, backoff / 2 + Math.random() * (backoff / 2));
          backoff = Math.min(backoff * 2, 15_000);
        }
      };
    };

    // Mirrors web/src/lib/realtimeSocket.ts + chatSync.ts + postSync.ts.
    const onEvent = (event: SocketEvent) => {
      stats.events[event.type] = (stats.events[event.type] ?? 0) + 1;
      if (event.type === "chat_updated") {
        if (event.change === "message_created") {
          if (event.senderId === id) {
            const sends = pendingEchoes.get(event.chatId);
            const sentAt = sends?.shift();
            if (sentAt !== undefined) {
              stats.echo[bucketOf(performance.now() - sentAt)]!++;
              stats.echoCount++;
            }
          }
          if (screen === "chats" && event.chatId === openChat) {
            const chatId = event.chatId;
            refetch(`messages:${chatId}`, async () => {
              const page = await call(
                "GET /chats/:id/messages?after",
                "GET",
                latestCursor
                  ? `/chats/${chatId}/messages?after=${latestCursor}&limit=100`
                  : `/chats/${chatId}/messages?limit=30`,
              );
              const ids: number[] = (page?.messages ?? []).map((m) => m.id);
              if (page?.latestCursor && openChat === chatId)
                latestCursor = page.latestCursor;
              if (ids.length && openChat === chatId) {
                latestInOpenChat = Math.max(latestInOpenChat, ...ids);
                // useMarkReadWhileVisible
                await call(
                  "POST /chats/:id/read",
                  "POST",
                  `/chats/${chatId}/read`,
                  {
                    messageId: latestInOpenChat,
                  },
                );
              }
            });
            return;
          }
          // Not in view: the list (if mounted) and the badge (always) refetch.
          refetch("unread", () =>
            call("GET /chats/unread-count", "GET", "/chats/unread-count"),
          );
          if (screen === "chats") refetch("chats", loadChats);
          return;
        }
        if (event.change === "read") return; // patched in place / own read
        refetch("chats", loadChats);
        refetch("unread", () =>
          call("GET /chats/unread-count", "GET", "/chats/unread-count"),
        );
        return;
      }
      if (event.type === "post_changed") {
        if (
          event.change === "created" &&
          !ownPosts.has(event.postId) &&
          config.feedRefetch
        ) {
          refetch("feed", loadFeed); // pullNewPost: feed is cached for everyone
        } else if (
          event.change === "updated" &&
          feedPostIds.includes(event.postId)
        ) {
          refetch(`post:${event.postId}`, () =>
            call("GET /posts/:id", "GET", `/posts/${event.postId}`),
          );
        }
        return;
      }
      if (event.type === "notifications_changed") {
        refetch("notifications", () =>
          call(
            "GET /notifications/unread-count",
            "GET",
            "/notifications/unread-count",
          ),
        );
      }
    };

    await connect();

    const act = async (action: Action) => {
      switch (action) {
        case "sendMessage": {
          const chatId = openChat ?? (chatIds.length ? pick(chatIds) : null);
          if (chatId === null) return;
          const sends = pendingEchoes.get(chatId) ?? [];
          // An echo that never came counts as missing, not as slow.
          if (sends.length > 5)
            stats.echoMissing += sends.splice(0, sends.length - 5).length;
          const started = performance.now();
          sends.push(started);
          pendingEchoes.set(chatId, sends);
          const res = await call(
            "POST /chats/:id/messages",
            "POST",
            `/chats/${chatId}/messages`,
            {
              contentType: "text",
              content: `sim message from ${id} at ${Date.now()}`,
              clientId: crypto.randomUUID(),
            },
          );
          if (!res) sends.splice(sends.indexOf(started), 1);
          return;
        }
        case "typing":
          if (openChat !== null) {
            await call(
              "POST /chats/:id/typing",
              "POST",
              `/chats/${openChat}/typing`,
            );
          }
          return;
        case "openChat":
          if (chatIds.length) await openConversation(pick(chatIds));
          return;
        case "scrollFeed":
          screen = "feed";
          openChat = null;
          await loadFeed();
          return;
        case "reactPost":
          if (feedPostIds.length) {
            const postId = pick(feedPostIds);
            const emoji = pick(["👍", "❤️", "😂", "😮"]);
            await call(
              "POST /posts/:id/reactions",
              "POST",
              `/posts/${postId}/reactions`,
              { emoji },
            );
          }
          return;
        case "comment":
          if (feedPostIds.length) {
            const postId = pick(feedPostIds);
            await call(
              "GET /posts/:id/comments",
              "GET",
              `/posts/${postId}/comments?limit=20`,
            );
            await call(
              "POST /posts/:id/comments",
              "POST",
              `/posts/${postId}/comments`,
              {
                content: `sim comment from ${id}`,
              },
            );
          }
          return;
        case "createPost": {
          const post = await call("POST /posts", "POST", "/posts", {
            contentType: "text",
            content: `sim post from ${id} about ${pick(["coffee", "jazz", "deploys", "cats"])}`,
          });
          if (post?.id) ownPosts.add(post.id);
          return;
        }
        case "search":
          await call(
            "GET /search",
            "GET",
            `/search?q=${pick(["lunch", "game", "deploy", "weekend", "music", "bug", "jazz", "cof"])}`,
          );
          return;
        case "notifications":
          await call("GET /notifications", "GET", "/notifications");
          return;
      }
    };

    while (Date.now() < deadline) {
      await Bun.sleep(Math.min(exp(totalRate), deadline - Date.now()));
      if (Date.now() >= deadline) break;
      await act(pickAction());
    }
    ws?.close();
  }

  await Promise.all(
    userIds.map((id, i) =>
      simulateUser(
        id,
        config.targets[id % config.targets.length]!,
        (i / userIds.length) * config.ramp * 1000 + Math.random() * 50,
      ),
    ),
  );
  await Bun.sleep(2500); // let the last snapshot flush
  process.exit(0);
}

// ---------------------------------------------------------------- coordinator
const fmt = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;

// Cores used per server process since the last sample, from cumulative CPU
// time (macOS `ps %cpu` is a decaying average, useless for bursts).
const lastCpu = new Map<number, { cpuSec: number; at: number }>();
const parseCpuTime = (s: string) =>
  s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
async function sampleServer(pids: number[]) {
  if (pids.length === 0) return [];
  const out = await Bun.$`ps -o pid=,time=,rss= -p ${pids.join(",")}`
    .nothrow()
    .text();
  const now = performance.now();
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pidS, timeS, rssS] = line.trim().split(/\s+/);
      const pid = Number(pidS);
      const cpuSec = parseCpuTime(timeS!);
      const prev = lastCpu.get(pid);
      lastCpu.set(pid, { cpuSec, at: now });
      const cores = prev
        ? (cpuSec - prev.cpuSec) / ((now - prev.at) / 1000)
        : 0;
      return {
        pid,
        cores: +cores.toFixed(2),
        rssMb: Math.round(Number(rssS) / 1024),
      };
    });
}

async function runCoordinator(config: Config) {
  const ids = Array.from({ length: config.users }, (_, i) => {
    // Spread the active users evenly across the seeded population, so a
    // 1k-active run on a 100k-user graph doesn't only touch neighbours.
    const stride = config.population / config.users;
    return config.firstUser + Math.floor(i * stride);
  });
  const perWorker = Array.from({ length: config.workers }, (_, w) =>
    ids.filter((_, i) => i % config.workers === w),
  );

  const total = emptySnapshot();
  let windowSnap = emptySnapshot();
  const wsOpenByWorker = new Array(config.workers).fill(0);
  const timeline: Array<Record<string, number | string>> = [];
  const serverSamples: Array<{
    t: number;
    procs: Awaited<ReturnType<typeof sampleServer>>;
  }> = [];
  const started = Date.now();

  const procs = perWorker.map((userIds, w) => {
    const proc = Bun.spawn(["bun", import.meta.path, "--worker"], {
      env: {
        ...process.env,
        SIM_CONFIG: JSON.stringify(config),
        SIM_USERS: JSON.stringify(userIds),
      },
      stdout: "pipe",
      stderr: "inherit",
    });
    void (async () => {
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.startsWith("{")) continue;
          const snap = JSON.parse(line) as Snapshot;
          wsOpenByWorker[w] = snap.wsOpen;
          snap.wsOpen = 0;
          mergeInto(total, snap);
          mergeInto(windowSnap, snap);
        }
      }
    })();
    return proc;
  });

  const REPORT_EVERY = 10;
  const reporter = setInterval(async () => {
    const t = Math.round((Date.now() - started) / 1000);
    const all = Object.values(windowSnap.endpoints);
    const reqs = all.reduce((a, e) => a + e.count, 0);
    const errs = all.reduce(
      (a, e) => a + Object.values(e.errors).reduce((x, y) => x + y, 0),
      0,
    );
    const merged = newHist();
    all.forEach((e) => e.hist.forEach((v, i) => (merged[i]! += v)));
    const events = Object.values(windowSnap.events).reduce((a, b) => a + b, 0);
    const procsNow = await sampleServer(config.serverPids);
    serverSamples.push({ t, procs: procsNow });
    const row = {
      t,
      wsOpen: wsOpenByWorker.reduce((a, b) => a + b, 0),
      rps: Math.round(reqs / REPORT_EVERY),
      errPct: reqs ? +((100 * errs) / reqs).toFixed(2) : 0,
      p50: +quantile(merged, 0.5).toFixed(1),
      p95: +quantile(merged, 0.95).toFixed(1),
      p99: +quantile(merged, 0.99).toFixed(1),
      eventsPerSec: Math.round(events / REPORT_EVERY),
      echoP95: +quantile(windowSnap.echo, 0.95).toFixed(1),
      genLagP99: +quantile(windowSnap.loopLag, 0.99).toFixed(1),
      serverCores: procsNow.map((p) => p.cores).join("/"),
      serverRssMb: procsNow.map((p) => p.rssMb).join("/"),
    };
    timeline.push(row);
    console.log(
      `[t=${String(t).padStart(4)}s] ws=${row.wsOpen} rps=${row.rps} err=${row.errPct}% ` +
        `p50=${fmt(row.p50)} p95=${fmt(row.p95)} p99=${fmt(row.p99)} ev/s=${row.eventsPerSec} ` +
        `echoP95=${fmt(row.echoP95)} genLag99=${fmt(row.genLagP99)} cores=${row.serverCores} rssMb=${row.serverRssMb}`,
    );
    windowSnap = emptySnapshot();
  }, REPORT_EVERY * 1000);

  await Promise.all(procs.map((p) => p.exited));
  clearInterval(reporter);
  await Bun.sleep(500);

  const elapsed = config.ramp + config.duration;
  const endpoints = Object.entries(total.endpoints)
    .map(([name, e]) => ({
      name,
      count: e.count,
      rps: +(e.count / elapsed).toFixed(1),
      errors: e.errors,
      p50: +quantile(e.hist, 0.5).toFixed(1),
      p95: +quantile(e.hist, 0.95).toFixed(1),
      p99: +quantile(e.hist, 0.99).toFixed(1),
    }))
    .sort((a, b) => b.count - a.count);

  console.log(
    "\nendpoint                               count    rps     p50      p95      p99   errors",
  );
  for (const e of endpoints) {
    console.log(
      `${e.name.padEnd(36)} ${String(e.count).padStart(8)} ${String(e.rps).padStart(6)} ` +
        `${fmt(e.p50).padStart(8)} ${fmt(e.p95).padStart(8)} ${fmt(e.p99).padStart(8)}   ` +
        `${Object.keys(e.errors).length ? JSON.stringify(e.errors) : "-"}`,
    );
  }
  console.log(
    `\nws: connects=${total.wsConnects} failures=${total.wsFailures} drops=${total.wsDrops} ` +
      `events=${JSON.stringify(total.events)}`,
  );
  console.log(
    `send->own echo: n=${total.echoCount} missing=${total.echoMissing} ` +
      `p50=${fmt(quantile(total.echo, 0.5))} p95=${fmt(quantile(total.echo, 0.95))} p99=${fmt(quantile(total.echo, 0.99))}`,
  );
  console.log(
    `generator: queueWait p99=${fmt(quantile(total.queueWait, 0.99))} loopLag p99=${fmt(quantile(total.loopLag, 0.99))}`,
  );

  if (config.out) {
    await Bun.write(
      config.out,
      JSON.stringify(
        {
          config: { ...config, jwtSecret: undefined },
          endpoints,
          ws: {
            connects: total.wsConnects,
            failures: total.wsFailures,
            drops: total.wsDrops,
            events: total.events,
          },
          echo: {
            n: total.echoCount,
            missing: total.echoMissing,
            p50: quantile(total.echo, 0.5),
            p95: quantile(total.echo, 0.95),
            p99: quantile(total.echo, 0.99),
          },
          generator: {
            queueWaitP99: quantile(total.queueWait, 0.99),
            loopLagP99: quantile(total.loopLag, 0.99),
          },
          timeline,
          serverSamples,
        },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${config.out}`);
  }
}

if (argv.includes("--worker")) {
  await runWorker(
    JSON.parse(process.env.SIM_CONFIG!),
    JSON.parse(process.env.SIM_USERS!),
  );
} else {
  const users = Number(flag("users", "100"));
  const config: Config = {
    users,
    population: Number(flag("population", String(users))),
    targets: flag("targets", "http://127.0.0.1:3000").split(","),
    duration: Number(flag("duration", "120")),
    ramp: Number(flag("ramp", "30")),
    workers: Number(
      flag("workers", String(Math.max(1, Math.min(8, Math.ceil(users / 750))))),
    ),
    rateMultiplier: Number(flag("rate-multiplier", "1")),
    jwtSecret: process.env.JWT_SECRET ?? "",
    firstUser: Number(flag("first-user", "1")),
    out: argv.includes("--out") ? flag("out", "") : null,
    serverPids: argv.includes("--server-pids")
      ? flag("server-pids", "").split(",").map(Number)
      : [],
    inflight: Number(flag("inflight", "128")),
    feedRefetch: !argv.includes("--no-feed-refetch"),
    // --rates reactPost=0,sendMessage=2 overrides per-minute action rates.
    rates: Object.fromEntries(
      (argv.includes("--rates") ? flag("rates", "") : "")
        .split(",")
        .filter(Boolean)
        .map((kv) => [kv.split("=")[0], Number(kv.split("=")[1])]),
    ),
  };
  if (!config.jwtSecret)
    throw new Error("JWT_SECRET is required (same as the backend's)");
  console.log(
    `[sim] ${config.users} users (of ${config.population}) x${config.rateMultiplier} rate -> ` +
      `${config.targets.join(", ")} | ${config.workers} workers, ${cpus().length} cpus | ` +
      `ramp ${config.ramp}s + ${config.duration}s` +
      (config.feedRefetch ? "" : " | no feed refetch") +
      (Object.keys(config.rates).length
        ? ` | rates ${JSON.stringify(config.rates)}`
        : ""),
  );
  await runCoordinator(config);
}
