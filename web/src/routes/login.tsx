import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { AuthForm } from "../components/AuthForm";
import { $api, usersQueryKey } from "../lib/api";
import { setSession } from "../lib/auth";
import { redirectIfSignedIn, validateAuthSearch } from "../lib/redirect";

export const Route = createFileRoute("/login")({
  validateSearch: validateAuthSearch,
  beforeLoad: redirectIfSignedIn,
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { redirect } = Route.useSearch();
  const login = $api.useMutation("post", "/users/login");

  return (
    <AuthForm
      mode="login"
      title="Welcome back"
      description="Log in to continue to Chat Platform."
      submitLabel="Log in"
      onSubmit={async ({ username, password }) => {
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
          No account yet?{" "}
          <Link
            to="/register"
            search={{ redirect }}
            className="font-medium text-primary hover:underline"
          >
            Register
          </Link>
        </>
      }
    />
  );
}
