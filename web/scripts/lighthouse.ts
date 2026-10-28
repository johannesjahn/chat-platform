// Lighthouse report for the production build (the `lighthouse` CI job). Run
// from `web/` after `bun run build`, with the backend up on its default
// http://localhost:3000 (the build's API URL): `bun run lighthouse`.
//
// The backend has to allow this script's origin (WEB_ORIGIN=
// http://localhost:4173), or every API call fails CORS — a preflight below
// fails the run if any page logs an error, so that can't go unnoticed.
//
// It's a report, not a gate on performance: on shared CI runners the same
// build's performance score moves by several points from run to run, so it
// only warns. Accessibility and best practices barely move, so those fail the
// run below MIN_SCORES — though the axe scan in e2e/accessibility.spec.ts is
// the real accessibility gate. Every page runs RUNS times and the median run
// is the one reported.
//
// Most pages need a signed-in user, so this drives Playwright's Chromium
// rather than letting Lighthouse launch its own: it signs a seeded user in
// through localStorage (as e2e/fixtures.ts does), tells Lighthouse not to
// reset storage, and instead clears the HTTP cache, cache storage and the
// service worker itself before each run — so every run is still a cold load.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";
import { computeMedianRun } from "lighthouse/core/lib/median-run.js";

const API_URL = process.env.LIGHTHOUSE_API_URL ?? "http://localhost:3000";
const APP_PORT = 4173;
const APP_URL = `http://localhost:${APP_PORT}`;
const DEBUG_PORT = 9222;
const RUNS = Number(process.env.LIGHTHOUSE_RUNS ?? 3);
const OUT_DIR = "lighthouse-reports";
const DIST = "dist/client";

const CATEGORIES = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
] as const;
type Category = (typeof CATEGORIES)[number];

// Below these the run fails. Performance and SEO only ever warn (see above;
// SEO checks things like crawlable links that a signed-in SPA doesn't need).
const MIN_SCORES: Partial<Record<Category, number>> = {
  accessibility: 0.95,
  "best-practices": 0.95,
};
const WARN_SCORES: Partial<Record<Category, number>> = {
  performance: 0.8,
};

// Must match STORAGE_KEY in src/lib/auth.ts.
const SESSION_STORAGE_KEY = "chat-platform-session";

// --- A static server for the build, standing in for the Cloudflare deploy:
// the SPA fallback wrangler.jsonc configures ("not_found_handling":
// "single-page-application") and compressed text responses, which an
// uncompressed local server would otherwise make look several times slower.
const COMPRESSIBLE = /\.(html|js|css|json|svg|webmanifest|txt)$/;
const ROOT = path.resolve(DIST);

async function serveStatic(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const resolved = path.resolve(ROOT, `.${decodeURIComponent(pathname)}`);
  let file = Bun.file(resolved);
  let name = resolved;
  if (
    pathname === "/" ||
    !resolved.startsWith(ROOT + path.sep) ||
    !(await file.exists())
  ) {
    name = path.join(ROOT, "index.html");
    file = Bun.file(name);
  }
  const headers = new Headers({ "content-type": file.type });
  if (
    COMPRESSIBLE.test(name) &&
    request.headers.get("accept-encoding")?.includes("gzip")
  ) {
    headers.set("content-encoding", "gzip");
    return new Response(Bun.gzipSync(await file.bytes()), { headers });
  }
  return new Response(file, { headers });
}

const server = Bun.serve({ port: APP_PORT, fetch: serveStatic });

// --- Seed a user with enough content that each page renders real rows.
async function api<T>(
  pathname: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(`${API_URL}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `POST ${pathname} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

type Session = { accessToken: string; user: { id: number } };

async function createUser(): Promise<Session> {
  const credentials = {
    username: `lh_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    password: "lighthouse-pw-123",
  };
  await api("/users/register", credentials);
  return api<Session>("/users/login", credentials);
}

const session = await createUser();
const other = await createUser();
const token = session.accessToken;
const post = await api<{ id: number }>(
  "/posts",
  {
    contentType: "text",
    content: "Lighthouse check\n\nA post with a comment under it.",
  },
  token,
);
await api(`/posts/${post.id}/comments`, { content: "A first comment." }, token);
const chat = await api<{ id: number }>(
  "/chats/direct",
  { userId: other.user.id },
  token,
);
await api(
  `/chats/${chat.id}/messages`,
  { contentType: "text", content: "Hello there!" },
  token,
);

const PAGES: { path: string; signedIn: boolean }[] = [
  { path: "/login", signedIn: false },
  { path: "/register", signedIn: false },
  { path: "/", signedIn: true },
  { path: `/posts/${post.id}`, signedIn: true },
  { path: `/users/${session.user.id}`, signedIn: true },
  { path: "/chats", signedIn: true },
  { path: `/chats/${chat.id}`, signedIn: true },
  { path: "/notifications", signedIn: true },
  { path: "/search?q=lighthouse", signedIn: true },
  { path: "/games", signedIn: true },
];

// --- Browser: Playwright's Chromium, with a debugging port for Lighthouse.
const profile = mkdtempSync(path.join(tmpdir(), "lighthouse-profile-"));
const context = await chromium.launchPersistentContext(profile, {
  args: [`--remote-debugging-port=${DEBUG_PORT}`],
});
const page = context.pages()[0] ?? (await context.newPage());
const cdp = await context.newCDPSession(page);
await page.goto(APP_URL);

async function setSignedIn(signedIn: boolean) {
  await page.evaluate(
    ({ key, value }) => {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    },
    {
      key: SESSION_STORAGE_KEY,
      value: signedIn ? JSON.stringify(session) : null,
    },
  );
}

async function coldStart() {
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Storage.clearDataForOrigin", {
    origin: APP_URL,
    storageTypes: "cache_storage,service_workers",
  });
}

// --- Preflight: every page loads once, signed in or out as it'll be
// audited, and renders its <h1> without a console error — otherwise the
// reports would be of an error page.
const errors: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
for (const { path: pagePath, signedIn } of PAGES) {
  await setSignedIn(signedIn);
  await page.goto(`${APP_URL}${pagePath}`);
  await page
    .getByRole("heading", { level: 1 })
    .first()
    .waitFor({ timeout: 15_000 });
  // Let the page's first requests come back before moving on.
  await page.waitForLoadState("networkidle");
  if (errors.length > 0) {
    throw new Error(
      `${pagePath} logged errors before any audit ran (is the backend up at ${API_URL}, with WEB_ORIGIN=${APP_URL}?):\n${errors.join("\n")}`,
    );
  }
}

type Result = NonNullable<Awaited<ReturnType<typeof lighthouse>>>["lhr"];

mkdirSync(OUT_DIR, { recursive: true });
const reports: { path: string; lhr: Result }[] = [];
for (const { path: pagePath, signedIn } of PAGES) {
  await setSignedIn(signedIn);
  const runs: Result[] = [];
  const html: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    await coldStart();
    const result = await lighthouse(
      `${APP_URL}${pagePath}`,
      {
        port: DEBUG_PORT,
        output: "html",
        logLevel: "error",
        disableStorageReset: true,
        onlyCategories: [...CATEGORIES],
      },
      // Lighthouse's default: a mid-range phone on a throttled network
      // (simulated, so the numbers come from a model, not this runner's
      // network) — the app is mobile-first.
    );
    if (!result) throw new Error(`Lighthouse returned nothing for ${pagePath}`);
    runs.push(result.lhr);
    html.push(result.report as string);
  }
  const median = computeMedianRun(runs);
  const slug = pagePath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  await Bun.write(
    path.join(OUT_DIR, `${slug || "feed"}.html`),
    html[runs.indexOf(median)]!,
  );
  reports.push({ path: pagePath, lhr: median });
  console.log(
    `${pagePath}: ${CATEGORIES.map((c) => `${c} ${Math.round((median.categories[c]?.score ?? 0) * 100)}`).join(", ")}`,
  );
}

await context.close();
await server.stop();
rmSync(profile, { recursive: true, force: true });

// --- Summary: one row per page, then the verdict.
const score = (lhr: Result, category: Category) =>
  lhr.categories[category]?.score ?? 0;
const failures: string[] = [];
const warnings: string[] = [];
const rows = reports.map(({ path: pagePath, lhr }) => {
  const cells = CATEGORIES.map((category) => {
    const value = score(lhr, category);
    const min = MIN_SCORES[category];
    const warn = WARN_SCORES[category];
    const shown = String(Math.round(value * 100));
    if (min !== undefined && value < min) {
      failures.push(
        `${pagePath}: ${category} ${shown} is below ${Math.round(min * 100)}`,
      );
      return `❌ ${shown}`;
    }
    if (warn !== undefined && value < warn) {
      warnings.push(
        `${pagePath}: ${category} ${shown} is below ${Math.round(warn * 100)}`,
      );
      return `⚠️ ${shown}`;
    }
    return shown;
  });
  const lcp = lhr.audits["largest-contentful-paint"]?.displayValue ?? "–";
  const tbt = lhr.audits["total-blocking-time"]?.displayValue ?? "–";
  const cls = lhr.audits["cumulative-layout-shift"]?.displayValue ?? "–";
  return `| \`${pagePath}\` | ${cells.join(" | ")} | ${lcp} | ${tbt} | ${cls} |`;
});
const summary = [
  `### Lighthouse (mobile, median of ${RUNS} runs)`,
  "",
  "| Page | Performance | Accessibility | Best practices | SEO | LCP | TBT | CLS |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows,
  "",
  "Full reports are in the `lighthouse-reports` artifact.",
  "",
].join("\n");
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
for (const warning of warnings) console.log(`::warning::${warning}`);
for (const failure of failures) console.error(`::error::${failure}`);
if (failures.length > 0) process.exit(1);
