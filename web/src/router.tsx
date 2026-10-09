import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { NotFoundPage, RouteErrorPage } from "./components/RouteFallbacks";

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    // Every navigation runs through `document.startViewTransition`, so the
    // browser cross-fades the outgoing route into the incoming one and morphs
    // any element the two screens share a `view-transition-name` for — the
    // chat-list avatar/title growing into the conversation header being the
    // one this app leans on (see ChatListItem and routes/chats/$id.tsx).
    // styles.css owns what those transitions look like, including turning
    // them off under `prefers-reduced-motion`. Browsers without the API
    // simply swap the route as before; nothing here is load-bearing.
    defaultViewTransition: true,
    // Unknown URLs and render/loader errors land on styled screens inside the
    // app shell instead of TanStack's bare "Not Found" text (issue #496).
    defaultNotFoundComponent: NotFoundPage,
    defaultErrorComponent: RouteErrorPage,
  });
  // Only a change of page earns the transition (issue #574). Re-clicking the
  // nav item for the page you're on still navigates — the router reloads the
  // same location — and a search-param update (a filter, a tab, the search
  // box) only re-renders part of the page; under the blanket default both
  // replayed the whole enter animation over an unchanged screen.
  // `onBeforeNavigate` fires before the router reads `shouldViewTransition`
  // for this load, and the router resets it after each one, so this only
  // ever affects the navigation it ran for. (`defaultViewTransition`'s
  // `types` callback can't do this: the router only consults it in browsers
  // that support view-transition types.)
  router.subscribe("onBeforeNavigate", ({ pathChanged }) => {
    if (!pathChanged) router.shouldViewTransition = false;
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
