import { useQueries } from "@tanstack/react-query";
import { fetchClient } from "./api";

export type UserSummary = {
  username: string;
  displayName: string | null;
};

// The label to show for a user everywhere except the profile page: the
// display name when one is set, otherwise `@username`. The profile page
// (web/src/routes/users/$id.tsx) is the one place that still shows the raw
// username alongside this.
export function userLabel(user: UserSummary): string {
  return user.displayName || `@${user.username}`;
}

// The name handed to `Avatar` for initials — same preference, but without
// the `@` (Avatar.getInitials strips a leading `@` anyway, so this mostly
// matters for a multi-word display name's two-initial rendering).
export function userAvatarName(user: UserSummary): string {
  return user.displayName || user.username;
}

// Resolves a set of user ids to { username, displayName } via individual
// `GET /users/:id` requests (parallel, each independently cached) — used to
// label content by its author (e.g. a post's `authorId`) now that the
// unpaginated user list is gone (see issue #48) and a
// `$api.useQuery("get", "/users")` fetch of everyone just to resolve a
// handful of ids isn't an option anymore.
export function useUserSummariesById(
  ids: readonly number[],
  enabled: boolean,
): Map<number, UserSummary> {
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

  const summaryById = new Map<number, UserSummary>();
  for (const result of results) {
    if (result.data)
      summaryById.set(result.data.id, {
        username: result.data.username,
        displayName: result.data.displayName,
      });
  }
  return summaryById;
}
