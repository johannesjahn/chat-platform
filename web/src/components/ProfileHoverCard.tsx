import {
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Slot } from "@radix-ui/react-slot";
import { Link, useRouterState } from "@tanstack/react-router";
import { Loader2, MessageCircle, UserRound } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { PresenceDot } from "@/components/PresenceDot";
import { UserStatusBadge } from "@/components/UserStatusBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useStartDirectChat } from "@/lib/directChat";
import { errorMessage } from "@/lib/errors";
import { useMediaQuery } from "@/lib/media";
import { useTransitionState } from "@/lib/motion";
import { useIsOnline } from "@/lib/presence";
import { useUserStatus } from "@/lib/status";
import { userAvatarName, userHandle, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

// How long the pointer has to rest on a trigger before the card opens — long
// enough that sweeping the mouse across a feed opens (and fetches) nothing.
const OPEN_DELAY_MS = 400;
// How long the card survives the pointer leaving the trigger or the card:
// enough to cross the gap between them without it closing underneath you.
const CLOSE_DELAY_MS = 150;
const CARD_WIDTH_PX = 288; // `w-72`
const VIEWPORT_MARGIN_PX = 8;
const TRIGGER_GAP_PX = 8;
// Below the trigger unless there's less room than this under it, in which
// case it opens above. Roughly the card's loaded height.
const MIN_SPACE_BELOW_PX = 220;

// Devices whose primary pointer can hover precisely. Paired with the
// per-event `pointerType === "mouse"` check, so a touch on a hybrid laptop
// still just follows the link.
const HOVER_MEDIA_QUERY = "(hover: hover) and (pointer: fine)";

type Placement =
  | { side: "below"; top: number; left: number }
  | { side: "above"; bottom: number; left: number };

function placementFor(trigger: DOMRect): Placement {
  const left = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(
      trigger.left,
      window.innerWidth - CARD_WIDTH_PX - VIEWPORT_MARGIN_PX,
    ),
  );
  const spaceBelow = window.innerHeight - trigger.bottom;
  if (spaceBelow >= MIN_SPACE_BELOW_PX || spaceBelow >= trigger.top) {
    return { side: "below", top: trigger.bottom + TRIGGER_GAP_PX, left };
  }
  return {
    side: "above",
    bottom: window.innerHeight - trigger.top + TRIGGER_GAP_PX,
    left,
  };
}

// The card is portalled to <body>, but React still bubbles its events up
// the component tree — into whatever the trigger sits in: a search result
// row that's itself a link, a chat bubble with its long-press gesture.
// Nothing the card does should reach those.
function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * A pointer-only profile preview (issue #562): resting the mouse on
 * `children` — an `@mention`, an avatar, an author name — opens a card with
 * the user's avatar, name, status and presence, plus "Message" and "View
 * profile", so you can see who someone is without navigating away.
 *
 * `children` must be a single element that accepts a ref and pointer
 * handlers (a `Link`, a `span`); the props are slotted onto it rather than
 * wrapping it, so the trigger keeps its exact layout. Touch and keyboard
 * users get the element untouched — tap or Enter still follows the link.
 *
 * The user is fetched lazily (`GET /users/{id}`, the same cache entry
 * `useUserSummariesById` fills) only once the open delay has elapsed.
 */
export function ProfileHoverCard({
  userId,
  children,
}: {
  userId: number;
  children: ReactElement;
}) {
  const session = useSession();
  const canHover = useMediaQuery(HOVER_MEDIA_QUERY);
  const enabled = session !== null && canHover;

  // Opened against the location it was opened on — like `usePopover` — so
  // any navigation, including "View profile" from inside it, closes it.
  const href = useRouterState({ select: (s) => s.location.href });
  const [openState, setOpenState] = useState<{
    href: string;
    placement: Placement;
  } | null>(null);
  const open = enabled && openState !== null && openState.href === href;
  // The last placement, kept while the card animates out after closing.
  const [shownPlacement, setShownPlacement] = useState<Placement | null>(null);
  if (openState && openState.placement !== shownPlacement) {
    setShownPlacement(openState.placement);
  }

  const triggerRef = useRef<HTMLElement | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  // Destructured: the React compiler's lint treats reading anything off an
  // object that holds a ref as reading the ref during render.
  const {
    ref: cardRef,
    mounted: cardMounted,
    phase: cardPhase,
  } = useTransitionState<HTMLDivElement>(open);

  function clearTimers() {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }

  useEffect(() => clearTimers, []);

  function scheduleOpen(event: ReactPointerEvent) {
    if (!enabled || event.pointerType !== "mouse") return;
    window.clearTimeout(closeTimer.current);
    if (open) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setOpenState({ href, placement: placementFor(rect) });
    }, OPEN_DELAY_MS);
  }

  function scheduleClose(event: ReactPointerEvent) {
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(
      () => setOpenState(null),
      CLOSE_DELAY_MS,
    );
  }

  // Escape closes it, as does scrolling — the card is placed once, in
  // viewport coordinates, so it would otherwise drift away from its trigger.
  useEffect(() => {
    if (!open) return;
    const close = () => {
      clearTimers();
      setOpenState(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <Slot
        ref={triggerRef}
        onPointerEnter={scheduleOpen}
        onPointerLeave={scheduleClose}
      >
        {children}
      </Slot>
      {cardMounted &&
        shownPlacement &&
        createPortal(
          <div
            ref={cardRef}
            data-testid="profile-hover-card"
            inert={!open}
            onPointerEnter={scheduleOpen}
            onPointerLeave={scheduleClose}
            onClick={stopPropagation}
            onPointerDown={stopPropagation}
            onMouseDown={stopPropagation}
            onContextMenu={stopPropagation}
            style={
              shownPlacement.side === "below"
                ? { top: shownPlacement.top, left: shownPlacement.left }
                : { bottom: shownPlacement.bottom, left: shownPlacement.left }
            }
            className={cn(
              "fixed z-50 w-72 rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-xl",
              shownPlacement.side === "below"
                ? "origin-top-left"
                : "origin-bottom-left",
              cardPhase === "exiting"
                ? "motion-safe:animate-pop-close"
                : "motion-safe:animate-pop-open",
            )}
          >
            <ProfileHoverCardContent
              userId={userId}
              isSelf={session?.user.id === userId}
              onDone={() => {
                clearTimers();
                setOpenState(null);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

function ProfileHoverCardContent({
  userId,
  isSelf,
  onDone,
}: {
  userId: number;
  isSelf: boolean;
  onDone: () => void;
}) {
  const { data: user, error } = $api.useQuery("get", "/users/{id}", {
    params: { path: { id: String(userId) } },
  });
  const online = useIsOnline(userId);
  const status = useUserStatus(userId, user);
  const directChat = useStartDirectChat();
  const [messageError, setMessageError] = useState<string | null>(null);

  async function startDirectChat() {
    setMessageError(null);
    try {
      await directChat.start(userId);
      onDone();
    } catch (err) {
      setMessageError(errorMessage(err));
    }
  }

  if (error) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn&apos;t load this profile.
      </p>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center gap-3" aria-busy="true">
        <Skeleton className="size-11 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
    );
  }

  const handle = userHandle(user);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <Avatar
            name={userAvatarName(user)}
            avatarUrl={user.avatarUrl}
            avatarVariants={user.avatarVariants}
            size="lg"
          />
          <PresenceDot online={online} className="absolute right-0 bottom-0" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate font-semibold">{userLabel(user)}</span>
          {handle && (
            <span className="truncate text-sm text-muted-foreground">
              {handle}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {online ? "Online" : "Offline"}
          </span>
        </div>
      </div>
      <UserStatusBadge status={status} className="text-sm" />
      {messageError && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {messageError}
        </p>
      )}
      <div className="flex gap-2">
        {!isSelf && (
          <Button
            size="sm"
            className="flex-1"
            disabled={directChat.isPending}
            onClick={() => void startDirectChat()}
          >
            {directChat.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MessageCircle className="size-4" />
            )}
            Message
          </Button>
        )}
        <Button asChild size="sm" variant="outline" className="flex-1">
          <Link to="/users/$id" params={{ id: String(userId) }}>
            <UserRound className="size-4" />
            View profile
          </Link>
        </Button>
      </div>
    </div>
  );
}
