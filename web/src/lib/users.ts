import { useQueries } from "@tanstack/react-query";
import { fetchClient } from "./api";

// Resolves a set of user ids to usernames via individual `GET /users/:id`
// requests (parallel, each independently cached) — used to label content by
// its author (e.g. a post's `authorId`) now that the unpaginated user list
// is gone (see issue #48) and a `$api.useQuery("get", "/users")` fetch of
// everyone just to resolve a handful of ids isn't an option anymore.
export function useUsernamesById(
  ids: readonly number[],
  enabled: boolean,
): Map<number, string> {
  const uniqueIds = [...new Set(ids)];
  const results = useQueries({
    queries: uniqueIds.map((id) => ({
      queryKey: [
        "get",
        "/users/{id}",
        { params: { path: { id: String(id) } } },
      ] as const,
      queryFn: async () => {
        const { data, error } = await fetchClient.GET("/users/{id}", {
          params: { path: { id: String(id) } },
        });
        if (error) throw error;
        return data;
      },
      enabled,
    })),
  });

  const usernameById = new Map<number, string>();
  for (const result of results) {
    if (result.data) usernameById.set(result.data.id, result.data.username);
  }
  return usernameById;
}
