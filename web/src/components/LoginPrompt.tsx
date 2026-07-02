import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type LoginPromptProps = {
  title: string;
  description: string;
};

export function LoginPrompt({ title, description }: LoginPromptProps) {
  return (
    <Card className="w-full max-w-xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button asChild>
          <Link to="/login">Log in</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/register">Create an account</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
