import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { RouterClient } from "@tanstack/react-router/ssr/client";
import { getRouter } from "./router";

// TanStack Start's default client entry renders `StartClient`, which also
// sets up the server-function RPC client and its serializer (seroval), about
// 10 kB gzipped before hydration. This app is a static SPA shell with no
// server functions, so it hydrates through the router alone (issue #754).
// Adding a server function, a `createStart` instance or a serialization
// adapter means going back to `StartClient`.
const router = getRouter();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <RouterClient router={router} />
    </StrictMode>,
  );
});
