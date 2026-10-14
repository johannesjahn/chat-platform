import { type ComponentType, lazy, type LazyExoticComponent } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any props: this only carries the component's own type through.
type AnyComponent = ComponentType<any>;

export type PreloadableComponent<C extends AnyComponent> =
  LazyExoticComponent<C> & {
    // Starts fetching the component's chunk without rendering it, so that by
    // the time it's needed it's usually already there. Safe to call any
    // number of times — the import only ever runs once.
    preload: () => Promise<unknown>;
  };

// `React.lazy` for a *named* export, plus a `preload()` to warm its chunk
// ahead of the first render (issue #604). The shell pieces split out of the
// entry chunk all render nothing until they're needed, so the root preloads
// them on idle and the first `Ctrl/⌘+K` or `?` rarely waits on the network.
export function lazyNamed<
  M extends Record<K, AnyComponent>,
  K extends keyof M & string,
>(load: () => Promise<M>, name: K): PreloadableComponent<M[K]> {
  let promise: Promise<M> | undefined;
  // A failed fetch (offline, a deploy swapped the chunks) isn't cached, so
  // the next render or preload tries again.
  const preload = () =>
    (promise ??= load().catch((error: unknown) => {
      promise = undefined;
      throw error;
    }));
  const component = lazy(() =>
    preload().then((module) => ({ default: module[name] })),
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
