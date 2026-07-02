import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { AuthForm } from "../components/AuthForm";
import { $api, usersQueryKey } from "../lib/api";
import { setSession } from "../lib/auth";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const login = $api.useMutation("post", "/users/login");

  return (
    <AuthForm
      title="Welcome back"
      description="Log in to continue to Chat Platform."
      submitLabel="Log in"
      onSubmit={async ({ username, password }) => {
        const session = await login.mutateAsync({
          body: { username, password },
        });
        setSession(session);
        await queryClient.invalidateQueries({ queryKey: usersQueryKey });
        await router.navigate({ to: "/" });
      }}
      footer={
        <>
          No account yet?{" "}
          <Link
            to="/register"
            className="font-medium text-primary hover:underline"
          >
            Register
          </Link>
        </>
      }
    />
  );
}
