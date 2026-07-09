import { useEffect, useRef, useState } from "react";
import { registerSW } from "virtual:pwa-register";

type PwaUpdateState = {
  needRefresh: boolean;
  updateApp: () => void;
};

// Registers the service worker once per page load and exposes whether a new
// version has been installed and is waiting to take over.
export function usePwaUpdate(): PwaUpdateState {
  const [needRefresh, setNeedRefresh] = useState(false);
  const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(
    null,
  );

  useEffect(() => {
    updateSWRef.current = registerSW({
      onNeedRefresh: () => setNeedRefresh(true),
    });
  }, []);

  return {
    needRefresh,
    updateApp: () => {
      void updateSWRef.current?.(true);
    },
  };
}
