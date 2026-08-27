import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

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
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
