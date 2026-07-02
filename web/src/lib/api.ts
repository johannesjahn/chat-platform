// Typed client for the chat-platform backend. `openapi-fetch` provides the
// runtime fetch client and `openapi-react-query` layers typed React Query hooks
// on top — both driven by the `paths` type generated from the OpenAPI spec
// (see `bun run gen:types`), so requests/responses stay in lockstep with the API.
import createFetchClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import { clearSession, getSession } from "./auth";
import type { components, paths } from "./api-types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const fetchClient = createFetchClient<paths>({ baseUrl: API_URL });

// Attach the access token to every request so protected endpoints (e.g. the
// user list) are authenticated, and drop the session if the server rejects it.
fetchClient.use({
  onRequest({ request }) {
    const session = getSession();
    if (session) {
      request.headers.set("Authorization", `Bearer ${session.accessToken}`);
    }
    return request;
  },
  onResponse({ response }) {
    if (response.status === 401) clearSession();
    return response;
  },
});

// `$api.useQuery("get", "/users")`, `$api.useMutation("post", "/users/login")`, …
export const $api = createQueryClient(fetchClient);

// React Query key for the user list, so mutations can invalidate it.
export const usersQueryKey = ["get", "/users"] as const;

export type PublicUser = components["schemas"]["User"];
export type Session = components["schemas"]["LoginResponse"];
export type Credentials = components["schemas"]["LoginBody"];
