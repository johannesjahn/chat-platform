import { Fragment, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Keyboard, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth";
import { useTransitionState } from "@/lib/motion";
import {
  closeOverlay,
  modKeyLabel,
  openOverlay,
  openPalette,
  useOverlayOpen,
} from "@/lib/shell";
import { cn } from "@/lib/utils";

// How long after `g` the second key of a "go to" chord is still accepted.
const CHORD_TIMEOUT_MS = 1200;

// `g` then one of these jumps there (issue #554).
const GO_TO = {
  f: "/",
  c: "/chats",
  n: "/notifications",
  u: "/users",
  g: "/games",
  s: "/settings",
} as const;

// Whether a key press belongs to something the user is typing into, where a
// bare letter must stay a letter.
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The app's global keyboard shortcuts (issue #554) and the `?` cheat sheet
 * that lists them. Mounted once at the root.
 *
 * `Ctrl/⌘+K` works from anywhere, a text field included — it's the one
 * combination nothing types. The bare-key shortcuts (`/`, `?`, `g …`) are
 * ignored while focus is in a field, and while any modifier other than
 * Shift is held, so they never eat a character or a browser shortcut.
 * Chat-specific keys (`Alt+↑/↓`) live with the chats layout, and composer
 * keys with the composer.
 */
export function KeyboardShortcuts() {
  const session = useSession();
  const navigate = useNavigate();
  const chordAtRef = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        if (!session) return;
        event.preventDefault();
        openPalette("switcher");
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      // A dialog of its own (confirm, group settings) owns the keyboard.
      if (document.querySelector("[aria-modal=true]")) return;

      const chordPending = Date.now() - chordAtRef.current < CHORD_TIMEOUT_MS;
      chordAtRef.current = 0;
      if (chordPending && event.key in GO_TO) {
        event.preventDefault();
        void navigate({ to: GO_TO[event.key as keyof typeof GO_TO] });
        return;
      }
      if (event.key === "g") {
        chordAtRef.current = Date.now();
      } else if (event.key === "/" && session) {
        event.preventDefault();
        openPalette("search");
      } else if (event.key === "?") {
        event.preventDefault();
        openOverlay("shortcuts");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, session]);

  return <ShortcutsDialog />;
}

type Shortcut = { keys: string[][]; label: string };

function shortcutGroups(mod: string): { title: string; items: Shortcut[] }[] {
  return [
    {
      title: "Anywhere",
      items: [
        { keys: [[mod, "K"]], label: "Quick switcher" },
        { keys: [["/"]], label: "Search" },
        { keys: [["?"]], label: "Show this list" },
        { keys: [["Esc"]], label: "Close a panel, menu or dialog" },
      ],
    },
    {
      title: "Go to",
      items: [
        { keys: [["g", "f"]], label: "Feed" },
        { keys: [["g", "c"]], label: "Chats" },
        { keys: [["g", "n"]], label: "Notifications" },
        { keys: [["g", "u"]], label: "Users" },
        { keys: [["g", "g"]], label: "Games" },
        { keys: [["g", "s"]], label: "Settings" },
      ],
    },
    {
      title: "Chats",
      items: [
        {
          keys: [
            ["Alt", "↑"],
            ["Alt", "↓"],
          ],
          label: "Previous / next chat",
        },
        {
          keys: [
            ["Alt", "Shift", "↑"],
            ["Alt", "Shift", "↓"],
          ],
          label: "Previous / next unread chat",
        },
      ],
    },
    {
      title: "Composer",
      items: [
        { keys: [["Enter"]], label: "Send" },
        { keys: [["Shift", "Enter"]], label: "New line" },
        { keys: [["↑"]], label: "Edit your last message (empty composer)" },
        { keys: [["Esc"]], label: "Cancel a reply or edit" },
        { keys: [[mod, "V"]], label: "Paste an image or file to attach" },
      ],
    },
  ];
}

function ShortcutsDialog() {
  const open = useOverlayOpen("shortcuts");
  const { ref, mounted, phase } = useTransitionState<HTMLDivElement>(open);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeOverlay("shortcuts");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;
  const exiting = phase === "exiting";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center"
      inert={!open}
    >
      <div
        className={cn(
          "absolute inset-0 bg-background/70 backdrop-blur-sm",
          exiting
            ? "motion-safe:animate-backdrop-fade-out"
            : "motion-safe:animate-backdrop-blur-in",
        )}
        onClick={() => closeOverlay("shortcuts")}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className={cn(
          "relative flex max-h-[calc(var(--app-height,100dvh)-2rem)] w-full max-w-2xl flex-col rounded-3xl border border-border bg-card shadow-2xl",
          exiting
            ? "motion-safe:animate-pop-close"
            : "motion-safe:animate-dialog-in",
        )}
      >
        <div className="flex items-center gap-3 border-b border-border px-6 py-4">
          <Keyboard className="size-5 text-primary" />
          <h2 id="shortcuts-title" className="text-lg font-semibold">
            Keyboard shortcuts
          </h2>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon"
            aria-label="Close"
            className="ml-auto"
            onClick={() => closeOverlay("shortcuts")}
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="grid min-h-0 gap-6 overflow-y-auto px-6 py-5 sm:grid-cols-2">
          {shortcutGroups(modKeyLabel()).map((group) => (
            <section key={group.title} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h3>
              <dl className="flex flex-col gap-1.5">
                {group.items.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <dt>{item.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      {item.keys.map((combo, i) => (
                        <Fragment key={i}>
                          {i > 0 && <span>or</span>}
                          <span className="flex items-center gap-0.5">
                            {combo.map((key) => (
                              <kbd
                                key={key}
                                className="min-w-5 rounded border border-border bg-background px-1.5 py-0.5 text-center font-sans text-[11px] text-foreground"
                              >
                                {key}
                              </kbd>
                            ))}
                          </span>
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
