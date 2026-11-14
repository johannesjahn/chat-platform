import { useEffect, useLayoutEffect, useRef, useState } from "react";

// How close to the bottom of the thread still counts as "at the bottom" —
// fractional scroll heights (sub-pixel layout, zoom) mean an exact
// `scrollHeight - scrollTop === clientHeight` comparison almost never lands.
const BOTTOM_EPSILON_PX = 24;

// The thread owns its scroll position; the router's scroll restoration
// (`scrollRestoration` in router.tsx) must never put it back anywhere. The
// router remembers every element it saw scroll under a selector — the
// element's `data-scroll-restoration-id` if it has one, else its CSS path —
// and once a navigation renders, writes the remembered offset back onto
// whatever element that selector finds. A thread restored that way lands at
// an offset from an older, shorter window: scrolled up from the newest
// message (issue #614).
//
// So the thread wears a restoration id that no remembered entry can match:
// unique to this mount (the random part outlives a reload, which a counter
// alone wouldn't — the router keeps its entries in sessionStorage), and
// renamed on every scroll, so an entry recorded on an earlier visit to this
// URL can't find a thread that has scrolled since — a docked window, or a
// search-param change, keeps its thread mounted across navigations. The
// conversation's own scrolls rename it as they're made, not just once their
// `scroll` event arrives a frame later, so one made while a navigation renders
// can't be undone by the entry recorded just before it. Whatever entry does
// still match was recorded after the last scroll, i.e. holds the offset the
// thread is already at.
const THREAD_RESTORATION_PREFIX = `chat-thread-${Math.random().toString(36).slice(2)}`;
let threadRestorationIds = 0;
function nextThreadRestorationId() {
  return `${THREAD_RESTORATION_PREFIX}-${++threadRestorationIds}`;
}
// Any code that scrolls the thread must call this too (see above).
export function renameForScrollRestoration(thread: HTMLElement) {
  thread.setAttribute("data-scroll-restoration-id", nextThreadRestorationId());
}

// How many pages of older history `jumpToMessage` will pull in while hunting
// for a message that isn't in the loaded window yet (a pinned message, or the
// message a reply is quoting). Generous enough to reach well back through a
// conversation, bounded so a jump can never turn into an unbounded scrape of
// the whole history.
const JUMP_MAX_EARLIER_PAGES = 20;

// How long the highlight `jumpToMessage` puts on the message it lands on (see
// `highlightKey` on MessageBubble and `animate-jump-flash`) is left there —
// two runs of the 0.9s pulse, which is also roughly how long the static tint
// the reduced-motion build paints instead should hold for.
const JUMP_FLASH_MS = 1800;

// How long a jump's smooth scroll is given to travel and settle before the
// thread goes back to reading its own scroll position normally. Comfortably
// longer than a smooth scroll across a screenful or two, short enough that it
// can't be mistaken for a scroll the reader did themselves.
const JUMP_SETTLE_MS = 1200;

// Resolves once the browser has painted, i.e. after React has committed any
// state update that landed in this tick. Two frames because the first can be
// scheduled ahead of React's own render for an update that came from outside
// an event handler (a resolved fetch), which would have us look for the newly
// loaded rows before they exist.
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * The thread's scroll position, owned by the conversation (issue #811 split
 * it out of ChatConversation): staying pinned to the newest message, keeping
 * the reader's place while older pages are prepended, paging older history
 * in near the top, and jumping to (and highlighting) a message anywhere in
 * the history — paging back to find it if it isn't loaded yet.
 *
 * Attach `scrollRef`, `onScroll` and `restorationId` to the scrolling
 * viewport and `contentRef` to the thread inside it.
 */
export function useThreadScroll({
  messages,
  myUserId,
  chatReady,
  newestPendingClientId,
  hasEarlier,
  loadEarlier,
  targetMessageId,
  messagesLoading,
}: {
  messages: ReadonlyArray<{ id: number; senderId: number }>;
  myUserId: number | undefined;
  // The conversation's own markup (and with it `scrollRef`/`contentRef`)
  // only mounts once the chat has loaded — the effects below key off this so
  // they re-run against the real elements rather than the loading
  // skeleton's nulls.
  chatReady: boolean;
  newestPendingClientId: string | undefined;
  hasEarlier: boolean | undefined;
  loadEarlier: () => Promise<{ data?: { hasEarlier?: boolean } }>;
  // Open scrolled to (and highlighting) this message instead of the newest.
  targetMessageId: number | undefined;
  messagesLoading: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Rendered once, then renamed imperatively on every scroll (see
  // `renameForScrollRestoration`); React leaves the attribute alone since
  // this value never changes.
  const [restorationId] = useState(nextThreadRestorationId);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<number | null>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  const initializedRef = useRef(false);
  // Whether the thread should stay stuck to its bottom edge. Starts true so a
  // chat that hasn't been scrolled yet keeps following the newest message
  // while it's still settling (see the ResizeObserver below).
  const atBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Set while `jumpToMessage` is paging backwards looking for its target, so
  // a second click (or a click during the hunt) doesn't start a rival loop.
  const jumpingRef = useRef(false);
  // Set while a jump's smooth scroll is still travelling, and cleared once it
  // has had time to land — see `jumpToMessage` for what it holds off.
  const jumpScrollingRef = useRef(false);
  const jumpSettleTimerRef = useRef<number | null>(null);
  // The message a jump last landed on, plus a counter that changes on every
  // jump so landing on the same message twice replays its highlight. Cleared
  // again after `JUMP_FLASH_MS`.
  const [jumpHighlight, setJumpHighlight] = useState<{
    messageId: number;
    key: number;
  } | null>(null);
  const jumpHighlightTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (jumpSettleTimerRef.current !== null) {
        window.clearTimeout(jumpSettleTimerRef.current);
      }
      if (jumpHighlightTimerRef.current !== null) {
        window.clearTimeout(jumpHighlightTimerRef.current);
      }
    },
    [],
  );

  function scrollToBottom(behavior: ScrollBehavior) {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    renameForScrollRestoration(el);
    atBottomRef.current = true;
    lastScrollTopRef.current = el.scrollTop;
  }

  const newestMessage = messages[messages.length - 1];
  const newestMessageId = newestMessage?.id;
  const newestMessageSenderId = newestMessage?.senderId;
  const oldestMessageId = messages[0]?.id;

  // Auto-scroll to the bottom on first load and whenever the newest message
  // changes — a real new message, not just an earlier page loading in.
  // `useLayoutEffect`, so the opening jump lands before the browser paints:
  // with `useEffect` the thread was visible at the top for a frame first.
  // A later message only pulls the view down when the user is already at the
  // bottom (or sent it themselves) — otherwise someone reading back through
  // the history would get yanked away from what they're reading.
  // The messages can be there before the thread is (the route's loader warms
  // them alongside the chat), so nothing counts as seen until `scrollRef`
  // is — otherwise the opening jump would be spent on a missing element.
  useLayoutEffect(() => {
    if (newestMessageId == null || !scrollRef.current) return;
    if (lastMessageIdRef.current === newestMessageId) return;
    lastMessageIdRef.current = newestMessageId;
    const isInitial = !initializedRef.current;
    initializedRef.current = true;
    if (isInitial) {
      scrollToBottom("auto");
    } else if (atBottomRef.current || newestMessageSenderId === myUserId) {
      scrollToBottom("smooth");
    }
  }, [newestMessageId, newestMessageSenderId, myUserId, chatReady]);

  // Content that grows *after* it was first laid out — an image finishing its
  // load, the composer expanding to a second line, the pinned bar opening —
  // pushes the newest message back out of view again. Re-pin to the bottom
  // whenever the thread or its viewport is resized while the user is already
  // there, so "opens scrolled to the bottom" survives those late reflows.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const observer = new ResizeObserver(() => {
      if (!atBottomRef.current) return;
      scroller.scrollTop = scroller.scrollHeight;
      renameForScrollRestoration(scroller);
    });
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, [chatReady]);

  // A message just sent (or queued offline) appends below the loaded history
  // the same way a real new message would — scroll down to reveal it, even
  // when the user had scrolled up: they just sent it. Keyed on the newest
  // one, so a pending bubble going away (its real message taking over)
  // doesn't count as a new send.
  useEffect(() => {
    if (newestPendingClientId === undefined) return;
    scrollToBottom("smooth");
  }, [newestPendingClientId]);

  // Preserve scroll position when older messages are prepended by the
  // infinite-scroll-to-top loader — without this the view would jump to the
  // (now-shifted) top. Uses useLayoutEffect (not useEffect) so the
  // correction lands before the browser paints the prepended content —
  // otherwise the user would see a visible flash at the wrong position.
  useLayoutEffect(() => {
    if (prevScrollHeightRef.current != null && scrollRef.current) {
      const delta =
        scrollRef.current.scrollHeight - prevScrollHeightRef.current;
      scrollRef.current.scrollTop += delta;
      renameForScrollRestoration(scrollRef.current);
      prevScrollHeightRef.current = null;
    }
  }, [oldestMessageId]);

  // Infinite scroll: reaching near the top of the scroll container loads the
  // previous page of older messages, anchored so scroll position is preserved
  // once they're prepended (see the effect above). The spinner clears when
  // the triggering fetch settles, even on failure.
  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    renameForScrollRestoration(el);
    // Re-evaluated on every scroll (ahead of the guards below) so the
    // auto-scroll and resize handlers know whether to keep following the
    // newest message. Landing at the bottom re-arms it; only scrolling *up*
    // releases it. Deliberately not "released whenever we're not at the
    // bottom": a scroll event is dispatched a frame after the scroll itself,
    // so a jump-to-bottom that raced content still growing underneath it
    // reports a stale gap — and treating that as "the user scrolled away"
    // used to switch the pinning off before it had ever taken effect.
    //
    // A jump's own smooth scroll is exempt: it usually sets off from the
    // bottom edge, so its first few events would re-arm the pinning it just
    // released and the view would be dragged back down (see `jumpToMessage`).
    if (!jumpScrollingRef.current) {
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom <= BOTTOM_EPSILON_PX) {
        atBottomRef.current = true;
      } else if (el.scrollTop < lastScrollTopRef.current) {
        atBottomRef.current = false;
      }
    }
    lastScrollTopRef.current = el.scrollTop;
    if (!initializedRef.current || loadingEarlier) return;
    if (!hasEarlier) return;
    if (el.scrollTop > 120) return;
    prevScrollHeightRef.current = el.scrollHeight;
    setLoadingEarlier(true);
    void loadEarlier().finally(() => setLoadingEarlier(false));
  }

  // Scroll the thread to a given message and briefly highlight it — used both
  // by the pinned bar's rows and by the quoted snippet on a reply ("what was
  // this answering?"). The target often isn't in the loaded window: a pin, or
  // a reply to something said much earlier, can point far up a history that
  // hasn't been paged in yet, so older pages are pulled in a page at a time
  // until it turns up (or the history runs out / the budget below is spent,
  // where it gives up quietly rather than erroring).
  //
  // `behavior` is "auto" when arriving from outside the chat (a search
  // result): there's no "where you were" to travel from, so it just lands.
  async function jumpToMessage(
    messageId: number,
    behavior: ScrollBehavior = "smooth",
  ) {
    // Scrolls to the message if it's rendered, reporting whether it was.
    const scrollToTarget = () => {
      const el = scrollRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${messageId}"]`,
      );
      if (!el) return false;
      // Landing anywhere but the bottom means the thread must stop following
      // the newest message, or the ResizeObserver above would yank the view
      // straight back down again — the messages that just paged in animate
      // as they mount, which is more than enough to trigger it. The flag
      // below holds that release in place until the smooth scroll has
      // actually travelled; see `onScroll`.
      atBottomRef.current = false;
      jumpScrollingRef.current = true;
      if (jumpSettleTimerRef.current !== null) {
        window.clearTimeout(jumpSettleTimerRef.current);
      }
      jumpSettleTimerRef.current = window.setTimeout(() => {
        jumpSettleTimerRef.current = null;
        jumpScrollingRef.current = false;
      }, JUMP_SETTLE_MS);
      el.scrollIntoView({ behavior, block: "center" });
      if (scrollRef.current) renameForScrollRestoration(scrollRef.current);
      // A double pulse (see `animate-jump-flash` in styles.css), so the
      // target is still calling attention to itself once a long smooth
      // scroll arrives. It's React state rather than a class poked onto the
      // row, which the row's own entrance animation out-ranked and any
      // re-render overwrote — see `highlightKey` on MessageBubble.
      setJumpHighlight((prev) => ({
        messageId,
        key: (prev?.key ?? 0) + 1,
      }));
      // A timer rather than `animationend`, because with motion reduced the
      // highlight paints a plain static tint and no animation runs at all —
      // there would be no event to clean up after, and it would never leave.
      if (jumpHighlightTimerRef.current !== null) {
        window.clearTimeout(jumpHighlightTimerRef.current);
      }
      jumpHighlightTimerRef.current = window.setTimeout(() => {
        jumpHighlightTimerRef.current = null;
        setJumpHighlight(null);
      }, JUMP_FLASH_MS);
      return true;
    };

    if (scrollToTarget()) return;
    // Already hunting (or the scroll handler is mid-page-load) — don't stack
    // a second run of overlapping `loadEarlier` fetches on top.
    if (jumpingRef.current || loadingEarlier) return;
    jumpingRef.current = true;
    // Reuses the infinite-scroll spinner, which doubles as the guard that
    // keeps `onScroll` from firing its own page load underneath this one.
    setLoadingEarlier(true);
    try {
      for (let i = 0; i < JUMP_MAX_EARLIER_PAGES; i++) {
        const result = await loadEarlier();
        // The refetch resolving only means the cache holds the older page —
        // React still has to commit it before the row exists in the DOM.
        await nextPaint();
        if (scrollToTarget()) return;
        if (!result.data?.hasEarlier) return;
      }
    } finally {
      jumpingRef.current = false;
      setLoadingEarlier(false);
    }
  }

  // Arriving with `?message=` (a search result): once the thread has
  // rendered, jump to that message instead of leaving the view at the bottom.
  // A layout effect declared after the scroll-to-bottom one above, so on the
  // commit that first shows the messages it runs second and the thread paints
  // straight at the target. Once per target: later renders (new messages, a
  // refetch) mustn't keep yanking the reader back to it. The param stays in
  // the URL — it works as a link to the message — and following a result
  // again remounts this view (it's keyed by chat, and search is another
  // route), so the jump happens afresh.
  const handledTargetRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (targetMessageId == null || !chatReady || messagesLoading) return;
    if (handledTargetRef.current === targetMessageId) return;
    handledTargetRef.current = targetMessageId;
    void jumpToMessage(targetMessageId, "auto");
    // `jumpToMessage` is recreated every render; this should only fire when
    // there's a new target and a thread to find it in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetMessageId, chatReady, messagesLoading]);

  return {
    scrollRef,
    contentRef,
    restorationId,
    onScroll,
    jumpToMessage,
    jumpHighlight,
    loadingEarlier,
  };
}
