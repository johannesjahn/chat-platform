import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

// Light/dark theming (issue #315). The palette is two token sets in
// styles.css — light on `:root`, dark under `.dark` — and the whole app
// switches by toggling that class on <html>. What decides the class:
//
// - "system" (the default): follow `prefers-color-scheme`, live — flipping
//   the OS setting flips an open tab.
// - "light"/"dark": an explicit choice from the header toggle or Settings,
//   which overrides the OS and is remembered per browser in localStorage.
//
// The first paint is handled by `THEME_BOOT_SCRIPT`, inlined into <head>
// so the class is already right before any CSS applies — otherwise a
// light-mode reader would get a flash of the dark palette (or vice versa)
// on every load while the bundle downloads.

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

// The browser-chrome color (`<meta name="theme-color">`) per theme — the
// page background, so the status bar and the app read as one surface.
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: "#f7f8fb",
  dark: "#0b0d13",
};

export const THEME_PREFERENCES: ReadonlyArray<ThemePreference> = [
  "system",
  "light",
  "dark",
];

// How each choice is labelled in the header toggle and in Settings.
export const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

// The order the header's one-button toggle steps through.
export function nextThemePreference(
  preference: ThemePreference,
): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(preference);
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length]!;
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    // Storage can throw outright (Safari private mode, blocked cookies).
    return "system";
  }
}

// One list for the module's lifetime. A `change` listener doesn't keep a
// MediaQueryList alive by itself: one created only to attach a listener
// (and a fresh one made to detach it) can be garbage-collected, silently
// taking the OS-preference updates with it.
let darkMediaList: MediaQueryList | null = null;

function darkMedia(): MediaQueryList {
  darkMediaList ??= window.matchMedia(DARK_MEDIA_QUERY);
  return darkMediaList;
}

function systemPrefersDark(): boolean {
  return darkMedia().matches;
}

// Puts `theme` on the document: the class every `dark:` variant and token
// keys off, `color-scheme` for native controls and scrollbars, and the
// browser-chrome color.
function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[theme]);
}

const listeners = new Set<() => void>();
let preference: ThemePreference | null = null;

function currentPreference(): ThemePreference {
  preference ??= readStoredPreference();
  return preference;
}

function sync() {
  applyTheme(resolveTheme(currentPreference(), systemPrefersDark()));
  for (const listener of listeners) listener();
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    if (next === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    }
  } catch {
    // Not persisted, but still applied for this page's lifetime.
  }
  sync();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // The first subscriber starts watching what can change the theme from
  // outside: the OS setting (matters while on "system") and another tab
  // writing the stored choice.
  if (listeners.size === 1) {
    darkMedia().addEventListener("change", sync);
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      darkMedia().removeEventListener("change", sync);
      window.removeEventListener("storage", onStorage);
    }
  };
}

function onStorage(event: StorageEvent) {
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
  preference = readStoredPreference();
  sync();
}

// The reader's choice and what it currently resolves to. The server
// snapshot (the prerendered SPA shell) is "system"/"dark"; the client
// corrects it right after hydration, and the boot script has already put
// the right class on <html> before that.
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
} {
  const pref = useSyncExternalStore(
    subscribe,
    currentPreference,
    () => "system" as const,
  );
  const prefersDark = useSyncExternalStore(
    subscribe,
    systemPrefersDark,
    () => true,
  );
  return { preference: pref, resolved: resolveTheme(pref, prefersDark) };
}

// Runs inline in <head>, before the stylesheet paints anything. It has to
// stand alone (it can't import this module), so it repeats the resolution
// above in miniature, with the storage key, media query and colors written
// out literally — a plain constant, never assembled from values (CodeQL
// flags code built by interpolation). Keep it in step with
// `THEME_STORAGE_KEY`, `DARK_MEDIA_QUERY` and `THEME_COLORS`.
export const THEME_BOOT_SCRIPT =
  '(function(){var r=document.documentElement;try{var p=localStorage.getItem("theme");' +
  'var d=p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);' +
  'r.classList.add(d?"dark":"light");r.style.colorScheme=d?"dark":"light";' +
  "var m=document.querySelector('meta[name=\"theme-color\"]');" +
  'if(m)m.setAttribute("content",d?"#0b0d13":"#f7f8fb");}catch(e){r.classList.add("dark");}})();';
