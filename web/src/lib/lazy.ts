import {
  type ComponentType,
  lazy,
  type LazyExoticComponent,
  useSyncExternalStore,
} from "react";
import { onlineManager } from "@tanstack/react-query";
import { whenOnline } from "./online";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any props: this only carries the component's own type through.
type AnyComponent = ComponentType<any>;

export type PreloadableComponent<C extends AnyComponent> =
  LazyExoticComponent<C> & {
    // Starts fetching the component's chunk without rendering it, so that by
    // the time it's needed it's usually already there. Safe to call any
    // number of times: an in-flight or finished import is reused, and only
    // a failed one is tried again.
    preload: () => Promise<unknown>;
  };

export type Connectivity = {
  isOnline: () => boolean;
  // Resolves once `isOnline` is true — straight away if it already is.
  whenOnline: () => Promise<void>;
};

// The app's own connectivity signal (lib/online.ts) rather than
// `navigator.onLine`: it's the one the offline banner shows, and real API
// responses correct it, so a browser that wrongly reports itself offline
// while requests still work doesn't leave a chunk waiting forever.
const appConnectivity: Connectivity = {
  isOnline: () => onlineManager.isOnline(),
  whenOnline,
};

// How long a load that failed while online waits before its one retry.
export const RETRY_DELAY_MS = 1000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Runs `load`, riding out a lost connection (issue #738): a load that fails
// while offline waits until the app is back online and tries again, as often
// as that keeps happening. A load that fails while online gets one retry
// after `RETRY_DELAY_MS` — the browser can report a dropped connection a
// moment after the request it broke has already failed, so that pause is
// also when a lagging "offline" gets its chance to show. A second failure
// while online rejects.
export async function loadWhenOnline<T>(
  load: () => Promise<T>,
  {
    connectivity = appConnectivity,
    delay = sleep,
  }: {
    connectivity?: Connectivity;
    delay?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  let failedOnline = false;
  for (;;) {
    try {
      return await load();
    } catch (error) {
      if (connectivity.isOnline()) {
        if (failedOnline) throw error;
        failedOnline = true;
        await delay(RETRY_DELAY_MS);
        if (connectivity.isOnline()) continue;
      }
      await connectivity.whenOnline();
      failedOnline = false;
    }
  }
}

// Whether any lazy chunk has failed for good this page load. Safari keeps a
// failed module import for the rest of the page's life (dependencies
// included), so there a retry can never succeed and only a reload recovers;
// `ChunkLoadNotice` offers one.
let chunkLoadFailed = false;
const chunkLoadListeners = new Set<() => void>();

function reportChunkLoadFailure(name: string, error: unknown) {
  console.error(`Couldn't load ${name}:`, error);
  chunkLoadFailed = true;
  for (const listener of chunkLoadListeners) listener();
}

export function useChunkLoadFailed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      chunkLoadListeners.add(listener);
      return () => chunkLoadListeners.delete(listener);
    },
    () => chunkLoadFailed,
    () => false,
  );
}

const Nothing = () => null;

// `React.lazy` for a *named* export, plus a `preload()` to warm its chunk
// ahead of the first render (issue #604). The shell pieces split out of the
// entry chunk all render nothing until they're needed, so the root preloads
// them on idle and the first `Ctrl/⌘+K` or `?` rarely waits on the network.
//
// The import goes through `loadWhenOnline`, so a chunk cut off by going
// offline just stays suspended until it can be fetched (issue #738). If it
// still fails, the component renders `fallback` (by default nothing) and
// `useChunkLoadFailed` flips, instead of rejecting: `React.lazy` would keep
// that rejection for the rest of the page's life, so the error boundary
// would replace the whole page until a reload.
export function lazyNamed<
  M extends Record<K, AnyComponent>,
  K extends keyof M & string,
>(
  load: () => Promise<M>,
  name: K,
  { fallback = Nothing }: { fallback?: AnyComponent } = {},
): PreloadableComponent<M[K]> {
  let promise: Promise<M> | undefined;
  // A failed fetch isn't cached, so the next render or preload tries again.
  const preload = () =>
    (promise ??= load().catch((error: unknown) => {
      promise = undefined;
      throw error;
    }));
  const component = lazy(() =>
    loadWhenOnline(preload).then(
      (module) => ({ default: module[name] }),
      (error: unknown) => {
        reportChunkLoadFailure(name, error);
        return { default: fallback as M[K] };
      },
    ),
  );
  return Object.assign(component, { preload });
}

// Runs `callback` once the browser is idle — after the first paint and
// hydration have had the main thread — or after `timeout` at the latest.
// Falls back to a plain timer where `requestIdleCallback` is missing
// (Safari).
export function whenIdle(callback: () => void, timeout = 2000): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 200);
  return () => window.clearTimeout(handle);
}
