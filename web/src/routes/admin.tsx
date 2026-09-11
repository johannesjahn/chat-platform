import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  CircleAlert,
  Gauge,
  HeartPulse,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { ActivityChart, type ActivitySeries } from "@/components/ActivityChart";
import { EmptyState } from "@/components/EmptyState";
import { LoginPrompt } from "@/components/LoginPrompt";
import { RelativeTime } from "@/components/RelativeTime";
import { CountUp } from "@/components/reactbits/CountUp";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { formatBytes } from "@/lib/attachments";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { components } from "@/lib/api-types";

type AdminStats = components["schemas"]["AdminStats"];

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

// Ranges the timeline can be drawn over. Anything longer is a job for the
// Prometheus-backed dashboards rather than this panel — the API caps the
// parameter at 90 days regardless (see MAX_ADMIN_TIMELINE_DAYS in src/Api.ts).
const RANGES = [7, 14, 30] as const;
type Range = (typeof RANGES)[number];

// Fixed per series *key*, never by rank, so changing the range or the series
// on screen never repaints one the reader has already learned. Validated as a
// set for colour-vision separation against this app's card surface — see the
// note in ActivityChart.tsx before substituting any of them.
const CONTENT_SERIES: ReadonlyArray<ActivitySeries> = [
  { key: "posts", label: "Posts", color: "#3987e5" },
  { key: "comments", label: "Comments", color: "#d95926" },
  { key: "messages", label: "Messages", color: "#199e70" },
];

// A lone series needs no legend, so it can simply wear the app's accent.
const SIGNUP_SERIES: ReadonlyArray<ActivitySeries> = [
  { key: "signups", label: "Signups", color: "oklch(0.62 0.19 277)" },
];

// `capitalize` would render "pubsub" as "Pubsub".
const DEPENDENCY_LABELS: Record<string, string> = {
  database: "Database",
  pubsub: "PubSub",
};

const WINDOW_LABELS: Record<string, string> = {
  "1d": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

const formatUptime = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

const percent = (ratio: number): string =>
  ratio === 0 ? "0%" : `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}%`;

function AdminPage() {
  const session = useSession();
  const isAdmin = session?.user.role === "admin";
  const [range, setRange] = useState<Range>(14);

  const {
    data: stats,
    isLoading,
    isFetching,
    error,
    refetch,
  } = $api.useQuery(
    "get",
    "/admin/stats",
    { params: { query: { days: String(range) } } },
    {
      enabled: isAdmin,
      // Operational numbers go stale the moment they're rendered; a minute
      // keeps the panel roughly live without hammering an endpoint that runs
      // a couple of dozen aggregates per call.
      refetchInterval: 60_000,
    },
  );

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <div className="flex w-full flex-wrap items-center gap-2">
        <Gauge className="size-5 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">
          <GradientText>Admin dashboard</GradientText>
        </h1>
        {stats && (
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              Updated <RelativeTime value={stats.generatedAt} />
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh statistics"
              onClick={() => void refetch()}
            >
              <RefreshCw
                className={cn("size-4", isFetching && "animate-spin")}
              />
            </Button>
          </div>
        )}
      </div>

      {!session ? (
        <LoginPrompt
          title="Log in to view the admin dashboard"
          description="Platform statistics are only available to administrators."
        />
      ) : !isAdmin ? (
        <EmptyState
          icon={ShieldAlert}
          title="Admins only"
          description="This dashboard shows platform-wide operational data, so it's limited to administrator accounts."
        />
      ) : error ? (
        <p className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load statistics: {errorMessage(error)}
        </p>
      ) : isLoading || !stats ? (
        <DashboardSkeleton />
      ) : (
        <>
          <HealthCard health={stats.health} />
          <TotalsGrid totals={stats.totals} />
          <ActivityCard activity={stats.activity} />
          <TimelineCard
            timeline={stats.timeline}
            range={range}
            onRangeChange={setRange}
          />
        </>
      )}
    </main>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex w-full flex-col gap-6">
      <Skeleton className="h-40 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}

// The form for a single number is a stat tile, not a one-bar chart.
function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">
        <CountUp value={value} />
      </span>
      {hint && (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      )}
    </div>
  );
}

function TotalsGrid({ totals }: { totals: AdminStats["totals"] }) {
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Totals</CardTitle>
        <CardDescription>
          Everything on the platform since it launched.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Users"
          value={totals.users}
          hint={`${totals.admins} admin${totals.admins === 1 ? "" : "s"}`}
        />
        <StatTile label="Posts" value={totals.posts} />
        <StatTile label="Comments" value={totals.comments} />
        <StatTile label="Reactions" value={totals.reactions} />
        <StatTile label="Chats" value={totals.chats} />
        <StatTile label="Messages" value={totals.messages} />
        <StatTile
          label="Attachments"
          value={totals.attachments}
          hint={formatBytes(totals.attachmentBytes)}
        />
      </CardContent>
    </Card>
  );
}

// A matrix of counts, deliberately not a chart: three windows of six measures
// is a table's job, and the numbers themselves are the story.
function ActivityCard({ activity }: { activity: AdminStats["activity"] }) {
  const rows = [
    {
      label: "Active users",
      hint: "Distinct people who posted, commented, reacted or messaged",
      pick: (w: AdminStats["activity"][number]) => w.activeUsers,
    },
    {
      label: "New users",
      pick: (w: AdminStats["activity"][number]) => w.newUsers,
    },
    { label: "Posts", pick: (w: AdminStats["activity"][number]) => w.newPosts },
    {
      label: "Comments",
      pick: (w: AdminStats["activity"][number]) => w.newComments,
    },
    {
      label: "Messages",
      pick: (w: AdminStats["activity"][number]) => w.newMessages,
    },
    {
      label: "Reactions",
      pick: (w: AdminStats["activity"][number]) => w.newReactions,
    },
  ];

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          <CardTitle>Activity</CardTitle>
        </div>
        <CardDescription>
          What happened in each trailing window, as of now.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="py-2 text-left font-medium">
                Measure
              </th>
              {activity.map((window) => (
                <th
                  key={window.window}
                  scope="col"
                  className="py-2 text-right font-medium"
                >
                  {WINDOW_LABELS[window.window] ?? window.window}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-border/50">
                <th scope="row" className="py-2 text-left font-normal">
                  {row.label}
                  {row.hint && (
                    <span className="block text-[11px] text-muted-foreground">
                      {row.hint}
                    </span>
                  )}
                </th>
                {activity.map((window) => (
                  <td
                    key={window.window}
                    className="py-2 text-right tabular-nums"
                  >
                    {row.pick(window)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function TimelineCard({
  timeline,
  range,
  onRangeChange,
}: {
  timeline: AdminStats["timeline"];
  range: Range;
  onRangeChange: (range: Range) => void;
}) {
  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Over time</CardTitle>
          {/* Range control sits in one row above the plots. */}
          <div className="ml-auto flex items-center gap-1 rounded-lg border border-border/60 p-0.5">
            {RANGES.map((option) => (
              <Button
                key={option}
                variant={option === range ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={option === range}
                onClick={() => onRangeChange(option)}
              >
                {option}d
              </Button>
            ))}
          </div>
        </div>
        <CardDescription>
          One bar per UTC day, oldest first. Hover a day for its breakdown.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Content created</h3>
          <ActivityChart
            caption={`Posts, comments and messages per day over the last ${range} days`}
            series={CONTENT_SERIES}
            points={timeline.map((point) => ({
              date: point.date,
              values: {
                posts: point.posts,
                comments: point.comments,
                messages: point.messages,
              },
            }))}
          />
        </section>
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Signups</h3>
          <ActivityChart
            caption={`New accounts per day over the last ${range} days`}
            series={SIGNUP_SERIES}
            points={timeline.map((point) => ({
              date: point.date,
              values: { signups: point.signups },
            }))}
          />
        </section>
      </CardContent>
    </Card>
  );
}

function HealthCard({ health }: { health: AdminStats["health"] }) {
  const healthy = health.status === "ok";
  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <HeartPulse className="size-4 text-primary" />
          <CardTitle>Health</CardTitle>
          {/* Status is never colour alone — icon plus word. */}
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              healthy
                ? "border-border bg-background/40 text-foreground"
                : "border-destructive/40 bg-destructive/10 text-destructive",
            )}
          >
            {healthy ? (
              <HeartPulse className="size-3.5" />
            ) : (
              <CircleAlert className="size-3.5" />
            )}
            {healthy ? "All systems go" : "Degraded"}
          </span>
        </div>
        <CardDescription>
          Live dependency checks, plus counters for the instance that served
          this request — with more than one replica, Prometheus remains the
          deployment-wide view.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul role="list" className="flex flex-col gap-2">
          {health.dependencies.map((dependency) => (
            <li
              key={dependency.name}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm"
            >
              <span className="font-medium">
                {DEPENDENCY_LABELS[dependency.name] ?? dependency.name}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {dependency.backend}
              </span>
              <span
                className={cn(
                  "ml-auto text-xs",
                  dependency.reachable
                    ? "text-muted-foreground"
                    : "font-medium text-destructive",
                )}
              >
                {dependency.reachable
                  ? `reachable · ${dependency.latencyMs}ms`
                  : "unreachable"}
              </span>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Requests served"
            value={health.requestsTotal}
            hint={`${percent(health.errorRate)} 5xx`}
          />
          <StatTile
            label="Server errors"
            value={health.serverErrorsTotal}
            hint="since process start"
          />
          <StatTile
            label="Rate-limited"
            value={health.rateLimitRejectionsTotal}
            hint="requests rejected"
          />
          <StatTile
            label="Live sockets"
            value={health.websocketConnections}
            hint="/ws connections open"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Instance up {formatUptime(health.uptimeSeconds)} · running v
          {health.version}
        </p>
      </CardContent>
    </Card>
  );
}
