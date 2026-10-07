import { useEffect } from "react";
import { stripTitleBadge } from "./title";

// The icon the badge is painted onto, and the size it's drawn at.
const FAVICON_SRC = "/favicon-32x32.png";
const FAVICON_SIZE = 32;
const BADGE_LINK_ID = "badge-favicon";

/**
 * Puts the unread count in front of every page's title — "(3) Feed · Chat
 * Platform" — and a dot on the favicon (issue #554). On a desktop the app is
 * usually a background tab, and until now only `/notifications` said there
 * was anything waiting.
 *
 * Titles are owned by the routes (`head` + `usePageTitle`), and change on
 * every navigation, so rather than every route knowing about the count this
 * watches `<head>` and re-applies the prefix to whatever title lands there.
 * The prefix is stripped before it's re-applied, so it never stacks, and
 * `usePageTitle` compares titles with it stripped too.
 */
export function useTabBadge(count: number) {
  useEffect(() => {
    const apply = () => {
      const base = stripTitleBadge(document.title);
      const next = count > 0 ? `(${count > 99 ? "99+" : count}) ${base}` : base;
      // Writing an identical title would still fire the observer below;
      // the equality check is what ends that loop.
      if (document.title !== next) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      const base = stripTitleBadge(document.title);
      if (document.title !== base) document.title = base;
    };
  }, [count]);

  // The dot only depends on whether there's anything unread at all.
  const hasUnread = count > 0;
  useEffect(() => {
    if (!hasUnread) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = FAVICON_SIZE;
      canvas.height = FAVICON_SIZE;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
      // A dot rather than digits: at 16px nothing more is legible, and the
      // title already carries the number.
      const r = FAVICON_SIZE * 0.22;
      const cx = FAVICON_SIZE - r - 1;
      const cy = r + 1;
      context.beginPath();
      context.arc(cx, cy, r + 2, 0, Math.PI * 2);
      context.fillStyle = "#0b0d13";
      context.fill();
      context.beginPath();
      context.arc(cx, cy, r, 0, Math.PI * 2);
      context.fillStyle = "#ef4444";
      context.fill();
      let link = document.getElementById(BADGE_LINK_ID) as HTMLLinkElement;
      if (!link) {
        link = document.createElement("link");
        link.id = BADGE_LINK_ID;
        link.rel = "icon";
        link.type = "image/png";
        document.head.appendChild(link);
      }
      link.href = canvas.toDataURL("image/png");
    };
    image.src = FAVICON_SRC;
    return () => {
      cancelled = true;
      // Back to the plain icon the browser found on its own.
      document.getElementById(BADGE_LINK_ID)?.remove();
    };
  }, [hasUnread]);
}
