import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { AuthForm } from "../components/AuthForm";
import { $api, MIN_USERNAME_LENGTH, USERNAME_PATTERN } from "../lib/api";
import { clearPendingSignup, getPendingSignup } from "../lib/googleSignIn";
import { redirectIfSignedIn, validateAuthSearch } from "../lib/redirect";
import { useCompleteSignIn } from "../lib/signIn";
import { staticTitle } from "../lib/title";

// The username step of a first Google sign-in (issue #693): /login verified
// the Google account and left a pending token, and the account is created
// here once a name is picked. Without a pending token there's nothing to
// finish, so it's back to /login.
export const Route = createFileRoute("/register")({
  head: () => staticTitle("Pick a username"),
  validateSearch: validateAuthSearch,
  beforeLoad: ({ search }) => {
    redirectIfSignedIn({ search });
    if (typeof window !== "undefined" && !getPendingSignup()) {
      throw redirect({
        to: "/login",
        search: { redirect: search.redirect },
        replace: true,
      });
    }
  },
  component: RegisterPage,
});

function RegisterPage() {
  const { redirect } = Route.useSearch();
  const completeSignIn = useCompleteSignIn(redirect);
  const registerGoogle = $api.useMutation("post", "/users/register/google");

  return (
    <AuthForm
      mode="username"
      title="Pick a username"
      description="One last step: choose the name people see and @mention you by. It can't be changed later."
      submitLabel="Create account"
      minUsernameLength={MIN_USERNAME_LENGTH}
      usernamePattern={USERNAME_PATTERN}
      onSubmit={async ({ username }) => {
        const pendingToken = getPendingSignup();
        if (!pendingToken) {
          throw new Error(
            "Your Google sign-in has expired. Please sign in again.",
          );
        }
        const session = await registerGoogle.mutateAsync({
          body: { pendingToken, username },
        });
        clearPendingSignup();
        await completeSignIn(session);
      }}
      footer={
        <>
          Not you?{" "}
          <Link
            to="/login"
            search={{ redirect }}
            onClick={clearPendingSignup}
            className="font-medium text-primary hover:underline"
          >
            Use another Google account
          </Link>
        </>
      }
    />
  );
}
