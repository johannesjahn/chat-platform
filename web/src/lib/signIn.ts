import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { type Session, usersQueryKey } from "./api";
import { setSession } from "./auth";

// Stores a freshly issued session and moves on to where the user was headed
// — their vetted `redirect` target (issue #481), or the feed. Shared by every
// way of signing in: Google, the username step after a first Google sign-in,
// and the admin password form.
export function useCompleteSignIn(redirect: string | undefined) {
  const router = useRouter();
  const queryClient = useQueryClient();
  return async (session: Session) => {
    setSession(session);
    await queryClient.invalidateQueries({ queryKey: usersQueryKey });
    if (redirect) {
      // A full in-app href (path + search + hash), already vetted by
      // validateAuthSearch — so it's pushed as-is rather than via `to`.
      router.history.push(redirect);
    } else {
      await router.navigate({ to: "/" });
    }
  };
}
