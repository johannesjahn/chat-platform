import { QueryClient } from "@tanstack/react-query";

// Single client for the SPA. Retries off keeps auth/validation errors (401/409)
// surfacing immediately instead of being retried.
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
