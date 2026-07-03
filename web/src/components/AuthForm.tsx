import { type ReactNode, useState } from "react";
import { Loader2 } from "lucide-react";
import { DotGrid } from "@/components/reactbits/DotGrid";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";

type AuthFormProps = {
  title: string;
  description: string;
  submitLabel: string;
  onSubmit: (credentials: {
    username: string;
    password: string;
  }) => Promise<void>;
  footer: ReactNode;
};

export function AuthForm({
  title,
  description,
  submitLabel,
  onSubmit,
  footer,
}: AuthFormProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <main className="relative flex min-h-[calc(100vh-57px)] items-center justify-center overflow-hidden px-4 py-16">
      {/* reactbits dot field — interactive background for the auth screens. */}
      <DotGrid
        className="opacity-70 mask-[radial-gradient(ellipse_at_center,black,transparent_75%)]"
        baseColor="#2a2f3a"
        activeColor="#6366f1"
        proximity={130}
        shockRadius={240}
      />

      <Card className="relative w-full max-w-sm border-border/60 bg-card/80 shadow-xl backdrop-blur-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-4 motion-safe:duration-500">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <form
            id="auth-form"
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setError(null);
              setPending(true);
              try {
                await onSubmit({ username, password });
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button
              type="submit"
              className="mt-1 w-full"
              disabled={pending || !username || !password}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              {pending ? "Please wait…" : submitLabel}
            </Button>
          </form>
        </CardContent>
        <CardFooter>
          <p className="text-sm text-muted-foreground">{footer}</p>
        </CardFooter>
      </Card>
    </main>
  );
}
