import { createFileRoute } from "@tanstack/react-router";
import { NotFoundPage } from "@/components/RouteFallbacks";

// Catches every URL no other route matches (issue #743). Without it, an
// unknown URL leaves the root route with no child match, and the root draws
// `defaultNotFoundComponent` straight into its `<Outlet />`. The static
// deploy answers such a URL with the SPA shell, which is prerendered at `/`
// and has a matched route's Suspense boundaries in that spot. Hydrating a
// bare `<main>` against them fails (React #418), and React renders the whole
// app again on the client.
//
// Here the 404 is this route's component, which Start code-splits like every
// other route's, so it suspends through hydration exactly like any deep link.
// That's also why the loader doesn't `throw notFound()`: the router draws a
// thrown not-found synchronously, outside those boundaries, and the mismatch
// is back. (The dev server answers these URLs with 200 instead of 404 now.)
export const Route = createFileRoute("/$")({
  component: NotFoundPage,
});
