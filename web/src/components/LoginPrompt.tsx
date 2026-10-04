import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useRedirectHere } from "@/lib/redirect";

type LoginPromptProps = {
  title: string;
  description: string;
};

export function LoginPrompt({ title, description }: LoginPromptProps) {
  // Bring the user back here once they've signed in (issue #481).
  const redirect = useRedirectHere();
  return (
    <Card className="w-full max-w-xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button asChild>
          <Link to="/login" search={{ redirect }}>
            Log in
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/register" search={{ redirect }}>
            Create an account
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
