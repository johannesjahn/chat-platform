import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Schema } from "effect";
import { Authentication } from "../Auth.ts";
import { Forbidden } from "./errors.ts";

// ---------------------------------------------------------------------------
// Admin dashboard — aggregated, admin-only operational statistics
//
// A single read-only endpoint backing the operator dashboard at `/admin` in
// the frontend. Everything it returns is an *aggregate* — a count, a sum, a
// latency, a per-day bucket. It deliberately exposes no per-user breakdown
// (no "most active users" panel, no per-user activity series), matching the
// same GDPR-driven scoping constraint the `active_users` gauge and the rest
// of the domain metrics in Metrics.ts already follow: an admin can already
// browse the user directory, but nothing here turns individual behaviour
// into a ranked, at-a-glance surface.
// ---------------------------------------------------------------------------

// Lifetime row counts — the "how big is this deployment" half of the
// dashboard, as opposed to `AdminActivityWindow` below (which is windowed).
export const AdminTotals = Schema.Struct({
  users: Schema.Finite,
  admins: Schema.Finite,
  posts: Schema.Finite,
  comments: Schema.Finite,
  chats: Schema.Finite,
  messages: Schema.Finite,
  reactions: Schema.Finite,
  attachments: Schema.Finite,
  // Summed `attachments.size`, i.e. bytes held in the object store for
  // attachments still referenced by a row (see AttachmentCleanup.ts).
  attachmentBytes: Schema.Finite,
}).annotate({ identifier: "AdminTotals" });

export type AdminTotals = typeof AdminTotals.Type;

export const AdminActivityWindowLabel = Schema.Literals([
  "1d",
  "7d",
  "30d",
]).annotate({ identifier: "AdminActivityWindowLabel" });

export type AdminActivityWindowLabel = typeof AdminActivityWindowLabel.Type;

// One trailing window's worth of activity. `activeUsers` is the same
// definition the `active_users{window}` gauge uses (see
// ActiveUsersMetrics.ts): distinct users who created a post, comment,
// reaction, or message inside the window — computed fresh per request here
// rather than read off the gauge, which only refreshes hourly.
export const AdminActivityWindow = Schema.Struct({
  window: AdminActivityWindowLabel,
  activeUsers: Schema.Finite,
  newUsers: Schema.Finite,
  newPosts: Schema.Finite,
  newComments: Schema.Finite,
  newMessages: Schema.Finite,
  newReactions: Schema.Finite,
}).annotate({ identifier: "AdminActivityWindow" });

export type AdminActivityWindow = typeof AdminActivityWindow.Type;

// One UTC day of the trailing timeline, for the dashboard's bar chart. Days
// with no activity are still present (zero-filled server-side) so the chart
// can render a continuous axis without reconstructing the calendar itself.
export const AdminTimelinePoint = Schema.Struct({
  // `YYYY-MM-DD`, UTC — the day boundary matches `date_trunc('day', ...)`
  // over the naive-UTC `created_at` columns (see db/schema.ts).
  date: Schema.String,
  signups: Schema.Finite,
  posts: Schema.Finite,
  comments: Schema.Finite,
  messages: Schema.Finite,
}).annotate({ identifier: "AdminTimelinePoint" });

export type AdminTimelinePoint = typeof AdminTimelinePoint.Type;

// A dependency `/ready` (see Health.ts) also checks, but reported with its
// measured round-trip and which implementation is actually wired up, so the
// dashboard can distinguish "healthy single-process dev box" from "healthy
// Postgres + Redis deployment" without a second endpoint.
export const AdminDependencyHealth = Schema.Struct({
  name: Schema.Literals(["database", "pubsub"]),
  reachable: Schema.Boolean,
  // Null when the check failed — there's no meaningful latency for a probe
  // that never came back.
  latencyMs: Schema.NullOr(Schema.Finite),
  // "pglite"/"postgres" for the database, "memory"/"redis" for pubsub.
  backend: Schema.String,
}).annotate({ identifier: "AdminDependencyHealth" });

export type AdminDependencyHealth = typeof AdminDependencyHealth.Type;

// Process-local runtime counters, read straight off the same `effect/Metric`
// registry `/metrics` renders (see Metrics.ts). Emphatically *this
// instance's* numbers since process start — with more than one replica the
// dashboard shows whichever one served the request, which is why the
// deployment-wide view still belongs in Prometheus/Grafana. Surfaced anyway
// because the single-instance case is the common one and it answers
// "is anything on fire right now?" without leaving the app.
export const AdminRuntimeHealth = Schema.Struct({
  // "ok" unless a dependency probe failed — the dashboard's headline badge.
  status: Schema.Literals(["ok", "degraded"]),
  version: Schema.String,
  uptimeSeconds: Schema.Finite,
  dependencies: Schema.Array(AdminDependencyHealth),
  websocketConnections: Schema.Finite,
  requestsTotal: Schema.Finite,
  // Requests answered with a 5xx, and the share of `requestsTotal` they
  // make up (0..1). Precomputed server-side so every client renders the
  // same number rather than each dividing it differently.
  serverErrorsTotal: Schema.Finite,
  errorRate: Schema.Finite,
  rateLimitRejectionsTotal: Schema.Finite,
  dbQueryErrorsTotal: Schema.Finite,
}).annotate({ identifier: "AdminRuntimeHealth" });

export type AdminRuntimeHealth = typeof AdminRuntimeHealth.Type;

export const AdminStats = Schema.Struct({
  // Epoch ms the snapshot was taken — nothing here is cached, but the
  // dashboard refetches on an interval and shows how fresh what's on screen
  // is.
  generatedAt: Schema.Finite,
  totals: AdminTotals,
  activity: Schema.Array(AdminActivityWindow),
  timeline: Schema.Array(AdminTimelinePoint),
  health: AdminRuntimeHealth,
}).annotate({ identifier: "AdminStats" });

export type AdminStats = typeof AdminStats.Type;

export const DEFAULT_ADMIN_TIMELINE_DAYS = 14;

// Bounds the timeline's per-day grouping (and the JSON it produces) — a
// quarter of history is more than an at-a-glance dashboard needs, and
// anything longer belongs in the Prometheus-backed dashboards instead.
export const MAX_ADMIN_TIMELINE_DAYS = 90;

// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// (api/posts.ts, see CLAUDE.md): it's inlined into query parameters, and a
// named `$ref` would silently drop them from the generated spec.
export const AdminStatsQuery = Schema.Struct({
  days: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_ADMIN_TIMELINE_DAYS }),
    ),
  ),
});

export const AdminGroup = HttpApiGroup.make("admin").add(
  // Admin-only: a non-admin caller gets a 403 rather than a filtered-down
  // payload, since every field here is deployment-wide operational data.
  HttpApiEndpoint.get("getAdminStats", "/admin/stats", {
    query: AdminStatsQuery,
    success: AdminStats,
    error: Forbidden,
  }).middleware(Authentication),
);
