import {
  createContext,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { lazyNamed, whenIdle } from "@/lib/lazy";
import type { ConfirmDialogProps } from "./confirm-dialog-panel";

// The dialog itself is a lazy chunk (issue #754): every page mounts the
// provider, but a confirm is only ever raised by a click, so its markup has
// no business in the entry chunk. It's warmed on idle, so by the time
// anyone asks it's there. Should it fail to load for good, the browser's own
// confirm stands in rather than leaving the caller waiting forever.
const ConfirmDialog = lazyNamed(
  () => import("./confirm-dialog-panel"),
  "ConfirmDialog",
  { fallback: NativeConfirm },
);

export type ConfirmOptions = {
  title: string;
  // What actually happens if they go ahead — the consequence, not a re-ask.
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // Destructive (the default) paints the confirm button red and shows the
  // warning glyph; turn it off for a confirm that changes rather than
  // destroys (e.g. handing over chat ownership).
  destructive?: boolean;
};

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

// The in-app replacement for `window.confirm` (issue #507): resolves `true`
// when the user confirms and `false` when they cancel, press Escape, or click
// the backdrop. Needs a `<ConfirmProvider>` above it (mounted once in
// __root.tsx).
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return confirm;
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // The last request stays rendered while the dialog animates out, after
  // `pending` has already been cleared.
  const [shown, setShown] = useState<ConfirmOptions | null>(null);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setPending((prev) => {
          // A second request while one is open supersedes it — the first
          // caller is told "no" rather than left hanging forever.
          prev?.resolve(false);
          return { ...options, resolve };
        });
        setShown(options);
      }),
    [],
  );

  useEffect(
    () => whenIdle(() => void ConfirmDialog.preload().catch(() => {})),
    [],
  );

  const settle = useCallback((ok: boolean) => {
    setPending((prev) => {
      prev?.resolve(ok);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {shown && (
        <Suspense fallback={null}>
          <ConfirmDialog
            open={pending !== null}
            options={shown}
            onSettle={settle}
            onExited={() => setShown(null)}
          />
        </Suspense>
      )}
    </ConfirmContext.Provider>
  );
}

function NativeConfirm({
  open,
  options,
  onSettle,
  onExited,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (open) onSettle(window.confirm(options.title));
    else onExited();
  }, [open, options, onSettle, onExited]);
  return null;
}
