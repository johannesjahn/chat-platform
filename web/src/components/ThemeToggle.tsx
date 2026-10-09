import { NavIcon } from "@/components/NavIcon";
import { Button } from "@/components/ui/button";
import { sidebarItemClassName } from "@/components/shell/sidebarItem";
import {
  nextThemePreference,
  setThemePreference,
  THEME_OPTIONS,
  type ThemePreference,
  useTheme,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

function themeOption(value: ThemePreference) {
  return THEME_OPTIONS.find((option) => option.value === value)!;
}

// The header's quick theme switch (issue #315): one button that steps
// System → Light → Dark, showing the current choice. Settings has the same
// choice spelled out as three options. `variant="sidebar"` renders it as a
// desktop sidebar row; otherwise it's an icon button for the top bar.
export function ThemeToggle({
  variant = "bar",
  className,
}: {
  variant?: "bar" | "sidebar";
  className?: string;
}) {
  const { preference } = useTheme();
  const current = themeOption(preference);
  const next = themeOption(nextThemePreference(preference));
  const label = `Theme: ${current.label} (switch to ${next.label.toLowerCase()})`;
  const onClick = () => setThemePreference(next.value);

  if (variant === "sidebar") {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className={cn(sidebarItemClassName, "group/nav-icon", className)}
      >
        <NavIcon icon={current.icon} className="size-5" />
        <span aria-hidden className="hidden xl:inline">
          Theme: {current.label}
        </span>
      </button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn("group/nav-icon", className)}
    >
      <NavIcon icon={current.icon} />
    </Button>
  );
}
