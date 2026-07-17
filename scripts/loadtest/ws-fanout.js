// WebSocket fan-out scenario (issue #195) — measures chat_updated delivery
// latency to N concurrent /ws connections sharing one group chat, the
// scenario with no existing coverage at scale (Realtime.ts/PubSub.ts). Run
// this against docker-compose.yml's real Postgres + Redis, not the default
// in-memory/PGlite dev config — see scripts/loadtest/README.md.
//
//   k6 run scripts/loadtest/ws-fanout.js
//   k6 run -e WS_PARTICIPANTS=20 -e ITERATIONS=50 scripts/loadtest/ws-fanout.js
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { WebSocket } from "k6/experimental/websockets";
import { setTimeout, clearTimeout } from "k6/experimental/timers";
import {
  BASE_URL,
  WS_URL,
  authHeaders,
  loginOrRegister,
  mintWsTicket,
  randomText,
} from "./lib/api.js";

// One VU per participant — see lib/api.js on why this stays small by
// default (register's per-IP-per-hour cap).
const PARTICIPANT_COUNT = Number(__ENV.WS_PARTICIPANTS || 5);
const ITERATIONS_PER_VU = Number(__ENV.ITERATIONS || 20);
// Generous relative to expected same-process/Redis fan-out latency
// (single-digit to low tens of ms) — how long a VU waits for its own
// chat_updated echo before giving up on that iteration.
const EVENT_TIMEOUT_MS = Number(__ENV.EVENT_TIMEOUT_MS || 5000);

export const options = {
  scenarios: {
    ws_fanout: {
      executor: "per-vu-iterations",
      vus: PARTICIPANT_COUNT,
      iterations: ITERATIONS_PER_VU,
      maxDuration: __ENV.MAX_DURATION || "5m",
    },
  },
  thresholds: {
    ws_fanout_latency_ms: ["p(95)<1000"],
    ws_fanout_timeouts: ["count<1"],
  },
};

const fanoutLatency = new Trend("ws_fanout_latency_ms", true);
const fanoutTimeouts = new Counter("ws_fanout_timeouts");

export function setup() {
  const users = [];
  for (let i = 0; i < PARTICIPANT_COUNT; i++) {
    users.push(loginOrRegister(`loadtest-ws-${i}`));
  }

  const owner = users[0];
  const chatRes = http.post(
    `${BASE_URL}/chats/group`,
    JSON.stringify({
      title: "WS fanout load test",
      participantIds: users.slice(1).map((u) => u.id),
    }),
    {
      headers: authHeaders(owner.accessToken),
      tags: { name: "createGroupChat" },
    },
  );
  check(chatRes, { "group chat created": (r) => r.status === 201 });
  if (chatRes.status !== 201) {
    throw new Error(
      `setup: createGroupChat failed with ${chatRes.status}: ${chatRes.body}`,
    );
  }

  return { users, chatId: chatRes.json().id };
}

// Each VU is one participant, acting as both publisher and listener for its
// own messages: createMessage fans a chat_updated event out to *every*
// participant, including the sender (see ChatsHandler.ts), so a VU can time
// its own send-to-receive latency without a separate correlation channel.
// Concurrent VUs all publish into the same chat at once, so "the next
// chat_updated a VU sees after its own send" occasionally belongs to another
// VU's message queued just ahead of it rather than strictly its own — that's
// fine here: under concurrent load it's a more honest measure of end-to-end
// pipeline latency (this instance's Redis subscriber to this socket) than a
// strictly self-correlated round trip would be, and it needs no server-side
// changes to correlate exactly.
export default function (data) {
  const user = data.users[(__VU - 1) % data.users.length];
  const ticket = mintWsTicket(user.accessToken);
  const url = `${WS_URL}/ws?ticket=${ticket}`;

  let sentAt = 0;
  let settled = false;
  let timeoutId = null;

  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    sentAt = Date.now();
    const res = http.post(
      `${BASE_URL}/chats/${data.chatId}/messages`,
      JSON.stringify({
        contentType: "text",
        content: randomText(`ws-${__VU}-${__ITER}`, 10),
      }),
      {
        headers: authHeaders(user.accessToken),
        tags: { name: "createMessage" },
      },
    );
    check(res, { "message sent": (r) => r.status === 201 });

    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      fanoutTimeouts.add(1);
      ws.close();
    }, EVENT_TIMEOUT_MS);
  });

  ws.addEventListener("message", (event) => {
    if (settled) return;
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (parsed.type === "chat_updated" && parsed.chatId === data.chatId) {
      settled = true;
      fanoutLatency.add(Date.now() - sentAt);
      clearTimeout(timeoutId);
      ws.close();
    }
  });

  ws.addEventListener("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
  });
}
