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

// A toast's own markup is a lazy chunk (issue #754): the provider — and the
// live region, which has to be there before anything is announced — is on
// every page, but a toast only ever follows an action. Warmed on idle.
const ToastItem = lazyNamed(() => import("./toast-item"), "ToastItem");

export type ToastOptions = {
  title: string;
  description?: ReactNode;
  // "warning" for an outcome that only partly worked (e.g. a forward that
  // reached some chats but not others).
  tone?: "success" | "warning";
  action?: { label: string; onClick: () => void };
};

type ShowToast = (options: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

// A short, self-dismissing note at the foot of the screen that an action
// finished — for outcomes worth confirming that happened somewhere the user
// isn't looking (issue #601: "Forwarded to 3 chats"). Needs a
// `<ToastProvider>` above it (mounted once in __root.tsx).
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used inside <ToastProvider>");
  return show;
}

// Older toasts make way for new ones rather than stacking up the screen.
const MAX_TOASTS = 3;

export type ToastEntry = ToastOptions & { id: number; open: boolean };

let nextToastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  useEffect(() => whenIdle(() => void ToastItem.preload().catch(() => {})), []);

  const show = useCallback<ShowToast>((options) => {
    setToasts((prev) => [
      ...prev.slice(-(MAX_TOASTS - 1)),
      { ...options, id: ++nextToastId, open: true },
    ]);
  }, []);

  const close = useCallback((id: number) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, open: false } : t)),
    );
  }, []);
  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* A live region without a `status` role: it has to be mounted before
          a toast is added for screen readers to announce it, and an
          always-present, usually empty `status` would be mistaken for the
          page's real status banners (the offline banner is one). */}
      <div
        aria-live="polite"
        // Above dialogs (z-50) and the confirm dialog (z-70): a toast is
        // often raised as a dialog closes, and must not land behind it.
        // Lifted clear of a chat's composer, which sits on the bottom edge.
        className="pointer-events-none fixed inset-x-0 bottom-24 z-[80] flex flex-col items-center gap-2 px-4"
      >
        <Suspense fallback={null}>
          {toasts.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              onClose={close}
              onExited={remove}
            />
          ))}
        </Suspense>
      </div>
    </ToastContext.Provider>
  );
}
