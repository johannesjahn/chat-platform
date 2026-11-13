import { $api } from "./api";

export { filterContacts } from "./contactFilter";

// The caller's own contacts (issue #764) — `GET /users/contacts`: people
// they share an accepted chat with, most recent activity first. It's what
// the New chat picker, `/users` and the palette's People section show
// before a directory search is possible, i.e. with nothing typed and for
// 1–2 characters, below `MIN_USER_SEARCH_QUERY_LENGTH`. Those suggestions
// must only ever come from this list, never the directory (issue #48).
export function useContacts(enabled: boolean) {
  return $api.useQuery("get", "/users/contacts", {}, { enabled });
}
