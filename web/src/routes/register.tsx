import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { AuthForm } from "../components/AuthForm";
import {
  $api,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  usersQueryKey,
} from "../lib/api";
import { setSession } from "../lib/auth";
import { redirectIfSignedIn, validateAuthSearch } from "../lib/redirect";

export const Route = createFileRoute("/register")({
  validateSearch: validateAuthSearch,
  beforeLoad: redirectIfSignedIn,
  component: RegisterPage,
});

function RegisterPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { redirect } = Route.useSearch();
  const register = $api.useMutation("post", "/users/register");
  const login = $api.useMutation("post", "/users/login");

  return (
    <AuthForm
      title="Create an account"
      description="Pick a username and password to get started."
      submitLabel="Register"
      minPasswordLength={MIN_PASSWORD_LENGTH}
      minUsernameLength={MIN_USERNAME_LENGTH}
      onSubmit={async ({ username, password }) => {
        await register.mutateAsync({ body: { username, password } });
        // Registration succeeded — log straight in for a smooth first visit.
        const session = await login.mutateAsync({
          body: { username, password },
        });
        setSession(session);
        await queryClient.invalidateQueries({ queryKey: usersQueryKey });
        if (redirect) {
          // A full in-app href (path + search + hash), already vetted by
          // validateAuthSearch — so it's pushed as-is rather than via `to`.
          router.history.push(redirect);
        } else {
          await router.navigate({ to: "/" });
        }
      }}
      footer={
        <>
          Already have an account?{" "}
          <Link
            to="/login"
            search={{ redirect }}
            className="font-medium text-primary hover:underline"
          >
            Log in
          </Link>
        </>
      }
    />
  );
}
