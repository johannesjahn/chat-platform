import {
  Link,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import {
  AlertTriangle,
  Compass,
  Home,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import {
  canReloadAutomatically,
  isStaleChunkError,
  reloadIntoLatestBuild,
} from "@/lib/staleBuild";
import { usePageTitle } from "@/lib/title";

// The router-wide fallbacks (issue #496), wired up as
// `defaultNotFoundComponent`/`defaultErrorComponent` in router.tsx. Both
// render where the failing route's content would have gone — inside the
// root layout's `<Outlet />` — so the nav stays put and the visitor always
// has a way back.
//
// Being components rather than routes, they have no `head` of their own, so
// `usePageTitle` gives them a title and the panel's title is the page's
// `<h1>` (issue #528).

export function NotFoundPage() {
  usePageTitle("Page not found");
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-10">
      <EmptyState
        icon={Compass}
        title="Page not found"
        pageHeading
        description="This page doesn't exist, or it may have been moved or deleted."
      >
        <Button asChild>
          <Link to="/">
            <Home />
            Go to feed
          </Link>
        </Button>
      </EmptyState>
    </main>
  );
}

export function RouteErrorPage(props: ErrorComponentProps) {
  return isStaleChunkError(props.error) ? (
    <StaleBuildPage />
  ) : (
    <ErrorPage {...props} />
  );
}

// The page's code is from a build that's no longer deployed (see
// lib/staleBuild.ts): move onto the new one by itself, once, and otherwise
// offer the reload — "Try again" can't help, since Safari keeps a failed
// import for the rest of the page's life.
function StaleBuildPage() {
  const [updating] = useState(
    () => typeof window !== "undefined" && canReloadAutomatically(),
  );
  usePageTitle(updating ? "Updating" : "Something went wrong");

  useEffect(() => {
    if (updating) reloadIntoLatestBuild();
  }, [updating]);

  return (
    <main
      role="alert"
      className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-10"
    >
      <EmptyState
        icon={updating ? RefreshCw : AlertTriangle}
        title={updating ? "Updating the app" : "Something went wrong"}
        pageHeading
        description={
          updating
            ? "A newer version came out while this page was open. Loading it now…"
            : "This page didn't finish loading. Reloading usually fixes it."
        }
      >
        {!updating && (
          <Button
            onClick={() => reloadIntoLatestBuild({ userInitiated: true })}
          >
            <RefreshCw />
            Reload
          </Button>
        )}
        <Button asChild variant="outline">
          <Link to="/">
            <Home />
            Go to feed
          </Link>
        </Button>
      </EmptyState>
    </main>
  );
}

function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const queryErrorReset = useQueryErrorResetBoundary();
  usePageTitle("Something went wrong");

  useEffect(() => {
    // Reset the query error boundary along with the route's own: otherwise a
    // retry re-renders straight into the same cached query error.
    queryErrorReset.reset();
  }, [queryErrorReset]);

  return (
    <main
      role="alert"
      className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-10"
    >
      <EmptyState
        icon={AlertTriangle}
        title="Something went wrong"
        pageHeading
        description="This page hit an unexpected error. Trying again usually fixes it."
      >
        <Button
          onClick={() => {
            // `invalidate` reruns the route's loaders, `reset` clears the
            // error boundary so the component gets another render.
            void router.invalidate();
            reset();
          }}
        >
          <RotateCw />
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link to="/">
            <Home />
            Go to feed
          </Link>
        </Button>
      </EmptyState>
      {import.meta.env.DEV && error instanceof Error && (
        <pre className="mt-2 max-w-full overflow-x-auto rounded-md border border-border bg-card/60 p-3 text-left text-xs text-muted-foreground">
          {error.message}
        </pre>
      )}
    </main>
  );
}
