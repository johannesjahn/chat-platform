import type { ReactNode } from "react";

// What session-dependent UI renders while `useSessionPending()` is true —
// the prerendered SPA shell and its hydration pass, when React can't know
// the session yet (issue #603). Both variants are in the markup; CSS keyed
// off the `data-session` marker the boot script put on <html> (see
// styles.css) shows only the one that matches, from the first paint. Each
// renders as `display: contents`, so the variant lays out as if it were
// the only child there.
//
// `signedOut` can simply be the real signed-out UI, so a signed-out reader
// waits on nothing; `signedIn` is a skeleton until the session is read.
export function SessionPlaceholder({
  signedIn,
  signedOut,
}: {
  signedIn: ReactNode;
  signedOut: ReactNode;
}) {
  return (
    <>
      <div data-session-only="in" className="contents">
        {signedIn}
      </div>
      <div data-session-only="out" className="contents">
        {signedOut}
      </div>
    </>
  );
}
