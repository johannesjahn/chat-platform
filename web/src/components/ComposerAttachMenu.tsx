import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type AttachMenuAction = {
  key: string;
  label: string;
  // One-line "what this does" under the label, in the way a chat app's
  // attach sheet labels its rows.
  description?: string;
  icon: ReactNode;
  onSelect: () => void;
};

type ComposerAttachMenuProps = {
  actions: AttachMenuAction[];
  disabled?: boolean;
  // The composer is already in one of the modes this menu opens (composing a
  // photo link, a file, a voice clip). The trigger then stops being a "+"
  // that opens the menu and becomes the way back out of that mode — which is
  // the same glyph rotated, so it reads as one control with two states
  // rather than a button that swaps identity.
  active?: boolean;
  activeLabel?: string;
  onCancel?: () => void;
};

// The single collapsed entry point to everything the composer can send
// besides text (issue: four always-visible mode buttons crowded the row on a
// phone). One tap opens the sheet, a second picks an option — so a file
// upload is two taps, with the second one opening the OS file picker
// directly rather than parking the user in front of a drop zone.
export function ComposerAttachMenu({
  actions,
  disabled = false,
  active = false,
  activeLabel = "Cancel",
  onCancel,
}: ComposerAttachMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  // A tap anywhere else — including into the message field — dismisses the
  // sheet, the way tapping away from an open menu does everywhere else.
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  // Opening moves focus into the sheet so it's navigable by keyboard alone;
  // closing hands focus back to the trigger it came from.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  function close({ restoreFocus = true } = {}) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      close({ restoreFocus: false });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = itemRefs.current.filter((node): node is HTMLButtonElement =>
      Boolean(node),
    );
    if (items.length === 0) return;
    const current = items.findIndex((node) => node === document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = (current + step + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Attach"
          onKeyDown={handleMenuKeyDown}
          // Anchored to the trigger's own corner so it springs out of the
          // button rather than appearing beside it.
          className="absolute bottom-full left-0 z-30 mb-2 min-w-52 origin-bottom-left rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl motion-safe:animate-pop-open"
        >
          {actions.map((action, index) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
              // Rows cascade in rather than all arriving at once — see
              // `stagger-in`, which reads this custom property.
              style={{ "--stagger-index": index } as CSSProperties}
              className="group/item flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent motion-safe:animate-pop-open motion-safe:stagger-in"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform duration-200 ease-spring group-hover/item:scale-110">
                {action.icon}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{action.label}</span>
                {action.description && (
                  <span className="truncate text-xs text-muted-foreground">
                    {action.description}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      <Button
        ref={triggerRef}
        type="button"
        size="icon"
        variant="ghost"
        disabled={disabled}
        aria-label={active ? activeLabel : "Attach"}
        aria-haspopup={active ? undefined : "menu"}
        aria-expanded={active ? undefined : open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (active) {
            onCancel?.();
            return;
          }
          setOpen((value) => !value);
        }}
        className="size-10 rounded-full text-muted-foreground hover:text-foreground"
      >
        <Plus
          // Open (or already in an attachment mode) turns the plus a quarter
          // turn into a close cross — one glyph, two meanings, and the
          // rotation is what tells you which one you're looking at.
          className={cn(
            "size-5 transition-transform duration-300 ease-spring",
            (open || active) && "rotate-45",
          )}
        />
      </Button>
    </div>
  );
}
