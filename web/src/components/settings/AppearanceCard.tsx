import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { setThemePreference, THEME_OPTIONS, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// Light, dark, or whatever the OS prefers (issue #315) — see lib/theme.ts.
// The header toggle steps through the same three; this spells them out.
export function AppearanceCard() {
  const { preference, resolved } = useTheme();

  return (
    <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Choose a light or dark theme, or follow your device&apos;s setting.
          Applies to this browser only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-3 gap-2"
        >
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const selected = value === preference;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setThemePreference(value)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-5" />
                {label}
              </button>
            );
          })}
        </div>
        {preference === "system" && (
          <p className="text-sm text-muted-foreground">
            Your device is currently set to {resolved}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
