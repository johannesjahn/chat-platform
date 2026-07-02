import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { AuthForm } from "../components/AuthForm";
import { $api, usersQueryKey } from "../lib/api";
import { setSession } from "../lib/auth";

export const Route = createFileRoute("/register")({
  component: RegisterPage,
});

function RegisterPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const register = $api.useMutation("post", "/users/register");
  const login = $api.useMutation("post", "/users/login");

  return (
    <AuthForm
      title="Create an account"
      description="Pick a username and password to get started."
      submitLabel="Register"
      onSubmit={async ({ username, password }) => {
        await register.mutateAsync({ body: { username, password } });
        // Registration succeeded — log straight in for a smooth first visit.
        const session = await login.mutateAsync({ body: { username, password } });
        setSession(session);
        await queryClient.invalidateQueries({ queryKey: usersQueryKey });
        await router.navigate({ to: "/" });
      }}
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Log in
          </Link>
        </>
      }
    />
  );
}
