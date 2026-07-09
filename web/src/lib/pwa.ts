import { useEffect, useRef, useState } from "react";
import { registerSW } from "virtual:pwa-register";

type PwaUpdateState = {
  needRefresh: boolean;
  updateApp: () => void;
};

// Registers the service worker once per page load. A new version is applied
// and the page reloaded as soon as it's detected, rather than waiting for the
// user to notice and click a manual prompt — a stale tab can otherwise keep
// running old frontend code against an already-changed backend API
// indefinitely (e.g. a response-shape change breaking an old cached bundle).
// `needRefresh`/`updateApp` are kept for `PwaUpdatePrompt` as a fallback in
// case the automatic reload is ever delayed.
export function usePwaUpdate(): PwaUpdateState {
  const [needRefresh, setNeedRefresh] = useState(false);
  const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(
    null,
  );

  useEffect(() => {
    updateSWRef.current = registerSW({
      immediate: true,
      onNeedRefresh: () => {
        setNeedRefresh(true);
        void updateSWRef.current?.(true);
      },
    });
  }, []);

  return {
    needRefresh,
    updateApp: () => {
      void updateSWRef.current?.(true);
    },
  };
}
