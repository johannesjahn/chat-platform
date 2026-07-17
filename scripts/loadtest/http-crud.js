// HTTP CRUD churn scenario (issue #195) — exercises the posts/comments/likes
// and chats/messages REST endpoints under sustained concurrent load. See
// scripts/loadtest/README.md for setup and how to run this.
//
//   k6 run scripts/loadtest/http-crud.js
//   k6 run -e BASE_URL=http://localhost:3000 -e VUS=20 -e DURATION=2m scripts/loadtest/http-crud.js
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter } from "k6/metrics";
import {
  BASE_URL,
  authHeaders,
  loginOrRegister,
  randomText,
} from "./lib/api.js";

// Kept small by default so setup() stays well inside /users/register's
// 5-per-IP-per-hour budget on a fresh backend (see lib/api.js). Raise VUS
// independently of USERS to add concurrency without registering more
// accounts — VUs just share the pool round-robin.
const USER_COUNT = Number(__ENV.USERS || 5);
const VUS = Number(__ENV.VUS || USER_COUNT);
const DURATION = __ENV.DURATION || "1m";

export const options = {
  scenarios: {
    http_crud: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:listPosts}": ["p(95)<500"],
    "http_req_duration{name:listMessages}": ["p(95)<500"],
  },
};

const postsCreated = new Counter("loadtest_posts_created");
const messagesCreated = new Counter("loadtest_messages_created");

export function setup() {
  const users = [];
  for (let i = 0; i < USER_COUNT; i++) {
    users.push(loginOrRegister(`loadtest-http-${i}`));
  }

  // One shared group chat so createMessage/listMessages churn on the same
  // write-heavy conversation every VU's iterations pile onto, instead of
  // each iteration starting a chat nobody else ever touches.
  const owner = users[0];
  const chatRes = http.post(
    `${BASE_URL}/chats/group`,
    JSON.stringify({
      title: "Load test chat",
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

export default function (data) {
  const user = data.users[(__VU - 1) % data.users.length];
  const headers = authHeaders(user.accessToken);

  group("posts", () => {
    const createRes = http.post(
      `${BASE_URL}/posts`,
      JSON.stringify({ contentType: "text", content: randomText("post") }),
      { headers, tags: { name: "createPost" } },
    );
    check(createRes, { "post created": (r) => r.status === 201 });
    if (createRes.status !== 201) return;
    postsCreated.add(1);
    const postId = createRes.json().id;

    const listRes = http.get(`${BASE_URL}/posts?limit=20`, {
      headers,
      tags: { name: "listPosts" },
    });
    check(listRes, { "posts listed": (r) => r.status === 200 });

    const likeRes = http.post(`${BASE_URL}/posts/${postId}/likes`, null, {
      headers,
      tags: { name: "likePost" },
    });
    check(likeRes, { "post liked": (r) => r.status === 200 });

    const commentRes = http.post(
      `${BASE_URL}/posts/${postId}/comments`,
      JSON.stringify({ content: randomText("comment", 20) }),
      { headers, tags: { name: "createComment" } },
    );
    check(commentRes, { "comment created": (r) => r.status === 201 });
  });

  group("chat", () => {
    const messageRes = http.post(
      `${BASE_URL}/chats/${data.chatId}/messages`,
      JSON.stringify({ contentType: "text", content: randomText("msg", 20) }),
      { headers, tags: { name: "createMessage" } },
    );
    check(messageRes, { "message sent": (r) => r.status === 201 });
    if (messageRes.status === 201) messagesCreated.add(1);

    const listRes = http.get(
      `${BASE_URL}/chats/${data.chatId}/messages?limit=30`,
      { headers, tags: { name: "listMessages" } },
    );
    check(listRes, { "messages listed": (r) => r.status === 200 });
  });

  sleep(1);
}
