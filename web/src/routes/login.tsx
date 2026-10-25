import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AuthError, AuthForm, AuthShell } from "../components/AuthForm";
import { GoogleSignInButton } from "../components/GoogleSignInButton";
import { $api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { setPendingSignup } from "../lib/googleSignIn";
import {
  type AuthSearch,
  redirectIfSignedIn,
  validateAuthSearch,
} from "../lib/redirect";
import { useCompleteSignIn } from "../lib/signIn";
import { staticTitle } from "../lib/title";

// `?method=password` opens the admin password form; anything else is the
// Google sign-in everyone uses (issue #693).
type LoginSearch = AuthSearch & { method?: "password" };

export const Route = createFileRoute("/login")({
  head: () => staticTitle("Log in"),
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    ...validateAuthSearch(search),
    method: search.method === "password" ? "password" : undefined,
  }),
  beforeLoad: redirectIfSignedIn,
  component: LoginPage,
});

function LoginPage() {
  const { redirect, method } = Route.useSearch();
  return method === "password" ? (
    <PasswordLogin redirect={redirect} />
  ) : (
    <GoogleLogin redirect={redirect} />
  );
}

function GoogleLogin({ redirect }: { redirect: string | undefined }) {
  const navigate = useNavigate();
  const completeSignIn = useCompleteSignIn(redirect);
  const loginGoogle = $api.useMutation("post", "/users/login/google");
  const [error, setError] = useState<string | null>(null);
  // Counts attempts so the error panel can be re-keyed per attempt.
  const [attempt, setAttempt] = useState(0);

  return (
    <AuthShell
      title="Welcome"
      description="Sign in with your Google account to continue to Chat Platform. New here? You'll pick a username next."
      footer={
        // Deliberately quiet: password sign-in exists only for the few
        // admin accounts without a Google account (and as the way in when
        // Google is down).
        <Link
          to="/login"
          search={{ redirect, method: "password" }}
          className="text-xs text-muted-foreground/80 hover:text-foreground hover:underline"
        >
          Admin sign-in
        </Link>
      }
    >
      {error && <AuthError key={attempt}>{error}</AuthError>}
      <GoogleSignInButton
        onCredential={async (idToken) => {
          setError(null);
          setAttempt((prev) => prev + 1);
          try {
            const result = await loginGoogle.mutateAsync({
              body: { idToken },
            });
            if ("needsUsername" in result) {
              // A first sign-in: no account until a username is picked.
              setPendingSignup(result.pendingToken);
              await navigate({ to: "/register", search: { redirect } });
            } else {
              await completeSignIn(result);
            }
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      />
      {loginGoogle.isPending && (
        <p className="mt-3 text-center text-sm text-muted-foreground">
          Signing you in…
        </p>
      )}
    </AuthShell>
  );
}

function PasswordLogin({ redirect }: { redirect: string | undefined }) {
  const completeSignIn = useCompleteSignIn(redirect);
  const login = $api.useMutation("post", "/users/login");

  return (
    <AuthForm
      mode="login"
      title="Admin sign-in"
      description="Password sign-in is only for admin accounts. Everyone else signs in with Google."
      submitLabel="Log in"
      onSubmit={async ({ username, password }) => {
        const session = await login.mutateAsync({
          body: { username, password },
        });
        await completeSignIn(session);
      }}
      footer={
        <Link
          to="/login"
          search={{ redirect }}
          className="font-medium text-primary hover:underline"
        >
          Sign in with Google instead
        </Link>
      }
    />
  );
}
