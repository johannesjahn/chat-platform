import { type ReactNode, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
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
  // Which credential the password field holds, for password managers
  // (issue #500): "register" asks for a *new* password, so managers offer to
  // generate and save one; "login" asks for the account's current one.
  mode: "login" | "register";
  title: string;
  description: string;
  submitLabel: string;
  onSubmit: (credentials: {
    username: string;
    password: string;
  }) => Promise<void>;
  footer: ReactNode;
  // Set on the register form to enforce and hint at the server's minimum
  // password length (issue #45); omitted on login, where an existing
  // account's password — possibly shorter, from before this floor existed —
  // must still be accepted.
  minPasswordLength?: number;
  // Likewise for the username (issue #483) — register only, so an account
  // whose name predates the floor can still log in.
  minUsernameLength?: number;
};

export function AuthForm({
  mode,
  title,
  description,
  submitLabel,
  onSubmit,
  footer,
  minPasswordLength,
  minUsernameLength,
}: AuthFormProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Counts submissions so the error panel can be re-keyed per attempt.
  const [attempt, setAttempt] = useState(0);

  const usernameTooShort =
    minUsernameLength !== undefined &&
    username.length > 0 &&
    username.length < minUsernameLength;
  const tooShort =
    minPasswordLength !== undefined &&
    password.length > 0 &&
    password.length < minPasswordLength;

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
          <CardTitle asChild>
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <p
              // Re-keyed on the attempt counter rather than on the message, so
              // a second failure with the *same* text is still visibly a new
              // rejection instead of an unchanged screen.
              key={attempt}
              role="alert"
              className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive motion-safe:animate-shake"
            >
              {error}
            </p>
          )}
          <form
            id="auth-form"
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setError(null);
              setAttempt((prev) => prev + 1);
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
                minLength={minUsernameLength}
                required
              />
              {minUsernameLength !== undefined && (
                <p
                  className={
                    usernameTooShort
                      ? "text-sm text-destructive"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {usernameTooShort
                    ? `Username must be at least ${minUsernameLength} characters.`
                    : `At least ${minUsernameLength} characters.`}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={
                    mode === "register" ? "new-password" : "current-password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={minPasswordLength}
                  required
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-0 right-0 text-muted-foreground hover:bg-transparent"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  aria-controls="password"
                  onClick={() => setShowPassword((prev) => !prev)}
                >
                  {showPassword ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </Button>
              </div>
              {minPasswordLength !== undefined && (
                <p
                  className={
                    tooShort
                      ? "text-sm text-destructive"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {tooShort
                    ? `Password must be at least ${minPasswordLength} characters.`
                    : `At least ${minPasswordLength} characters.`}
                </p>
              )}
            </div>
            <Button
              type="submit"
              className="mt-1 w-full"
              disabled={
                pending ||
                !username ||
                !password ||
                tooShort ||
                usernameTooShort
              }
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
