import type { components } from "./api-types";

type User = components["schemas"]["User"];

// `contacts` narrowed to those whose username or display name contains
// `query` (case-insensitive), keeping their recency order — the same
// "fragment of either name" matching the directory search does server-side
// (`searchUsers` in src/UsersHandler.ts). A blank query keeps everyone.
// Kept apart from contacts.ts so its unit test doesn't load the API client.
export function filterContacts<
  T extends Pick<User, "username" | "displayName">,
>(contacts: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...contacts];
  return contacts.filter(
    (user) =>
      user.username.toLowerCase().includes(needle) ||
      (user.displayName?.toLowerCase().includes(needle) ?? false),
  );
}
