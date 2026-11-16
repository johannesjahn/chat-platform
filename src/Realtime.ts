import {
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Metric,
  Schedule,
} from "effect";
import {
  realtimeUserEnvelopesTotal,
  websocketConnectionsActive,
  websocketConnectionsTotal,
} from "./Metrics.ts";
import { PresenceStore } from "./Presence.ts";
import { PresenceAudience } from "./PresenceAudience.ts";
import { PubSub } from "./PubSub.ts";
import { forkClaimRefresher, UserLocator } from "./UserLocator.ts";
import type { Message } from "./api/chats.ts";

// Pushed to every participant of a chat whenever something in it changes
// (new message, read receipt, rename, participants added/removed). `version`
// mirrors the chat's `version` column (see db/schema.ts) as of this
// mutation, letting a client that's tracking the last version it observed
// for a chat detect deterministically whether it missed an event in between
// (issue #55) — e.g. a gap wider than one, or a redelivery of a version it's
// already applied — rather than only being able to refetch blindly.
//
// `change`, when present, says what happened (issue #749), so a client can
// act on just that instead of refetching the chat list, the chat and its
// message window on every event — see `ChatChange`. It's optional and
// additive on purpose: a client that predates it ignores the extra fields
// and refetches everything, as it always did, and an event without it (any
// change not listed in `ChatChange`) still means "refetch everything".
export type ChatEvent = {
  readonly type: "chat_updated";
  readonly chatId: number;
  readonly version: number;
} & ({ readonly change?: undefined } | ChatChange);

// - "message_created": a new message (sent or forwarded) landed. Carries
//   who sent it, so a client showing the conversation can fetch just the
//   new message and leave the chat list and chat to its own mark-read —
//   and the message itself, as any participant but its sender sees it (no
//   `clientId`), so a client with the chat off screen can make it the
//   listed chat's preview and move it to the top instead of refetching the
//   chat list on every message. That refetch was what was left of a
//   message's fan-out cost under load (issue #834). Optional, like
//   `change`: without it a client refetches the list as before.
// - "read": `userId` moved their read watermark from `fromMessageId`
//   (exclusive) to `lastReadMessageId`. That's everything a read receipt
//   changes — every message from someone else in that range gains `userId`
//   in its `readByUserIds` — so the other participants patch it in place
//   with no request at all, and only the reader's own other tabs (whose
//   unread counts moved) refetch. Still sent to every participant rather
//   than only the senders it concerns: one publish either way, and a
//   participant left out would see a version gap on the next event and
//   have to refetch everything.
export type ChatChange =
  | {
      readonly change: "message_created";
      readonly messageId: number;
      readonly senderId: number;
      readonly message?: Message;
    }
  | {
      readonly change: "read";
      readonly userId: number;
      readonly fromMessageId: number;
      readonly lastReadMessageId: number;
    };

// Pushed to every user who had access to a chat the moment it's deleted
// (see `deleteChat`/`leaveChat` in chats/membershipHandlers.ts) — a
// dedicated event rather than a `chat_updated` with a bumped version because
// there's no surviving row to bump: the chat, its participants, and its
// messages are already gone by the time this is published. Clients drop it
// from any cached list/detail view unconditionally, without going through
// the version staleness check `chat_updated` uses (issue #66).
export type ChatDeletedEvent = {
  readonly type: "chat_deleted";
  readonly chatId: number;
};

// Pushed to every connected user whenever a post is created, edited, or
// deleted — the feed has no notion of "participants", so unlike chat events
// this goes out to everyone, not a filtered subset.
//
// `change` says which of the three happened, so a client can act on just the
// one post instead of refetching every feed page it has loaded (issue #662):
// patch a post it has cached, drop a deleted one without a request.
//
// Sent only to the sockets showing that post (`notifyPostViewers`: cards
// that `watch_post` it, plus its open comment sections), never broadcast
// (issue #828): sent to everyone, each post was one frame per online user,
// O(online²) cluster-wide. A new post isn't sent this way at all: it reaches
// feed viewers as a coalesced `feed_head` instead. "created" stays in the
// type for clients that predate that.
export type PostEvent = {
  readonly type: "post_changed";
  readonly postId: number;
  readonly change: "created" | "updated" | "deleted";
};

// Tells sockets in the feed room (`FEED_ROOM`) that posts newer than what they
// have may exist (issue #827): the ids announced since the last one, at most
// one event per `FeedHeadInterval` per instance however many posts land. The
// client shows a "new posts" pill and fetches only when it's used — fetching
// on every new post was one feed request per online user per post. Ids, not
// a count: the client drops ones it already has (its own post), and the
// server's blocked/muted filter only applies once it fetches.
export type FeedHeadEvent = {
  readonly type: "feed_head";
  readonly postIds: ReadonlyArray<number>;
};

// The latest reaction counts of the posts a socket is showing (issue #828).
// On a chronological feed the newest posts are on nearly every viewer's
// screen, so even a frame per reaction to just their viewers grows with
// users × reactions. Each instance instead keeps the latest counts per post
// and, once per `PostReactionsInterval`, sends each socket one frame covering
// every changed post it watches: frames scale with viewers, not reactions.
// Counts only, never `reactedByMe` (see ReactionEvent).
export type PostReactionsEvent = {
  readonly type: "post_reactions";
  readonly posts: ReadonlyArray<{
    readonly postId: number;
    readonly reactions: ReadonlyArray<{
      readonly emoji: string;
      readonly count: number;
    }>;
  }>;
};

// Pushed when a comment or reply on a post is created, edited, or deleted.
// Unlike `post_changed` this is *not* broadcast to everyone — a busy post's
// comment traffic would flood every connected client. It's scoped to the
// "post room": the sockets that have explicitly subscribed to this post's
// comment section (via a `subscribe_post_comments` message — see
// RealtimeSocket.ts and `notifyPostRoom` below), i.e. whoever currently has
// it open. Carries only ids; the client refetches the affected comment
// queries over REST, same convention as the other id-only events.
export type CommentEvent = {
  readonly type: "comment_changed";
  readonly postId: number;
  readonly commentId: number;
};

// Pushed when a reaction on a post, a comment/reply, or a chat message is
// added or removed (issue #216 extended this to messages; issue #215 widened
// it from the original binary "like", issue #67). A reaction on a *post* is
// no longer sent as this event: it went out feed-wide, O(online²) — every
// reaction a frame to every user (issue #828) — and is now batched into
// `post_reactions` instead. A reaction on a *comment* is scoped to that
// post's comment room (`notifyPostRoom`). A reaction on a
// *message* is scoped to the message's chat participants (`notifyUsers`,
// like `chat_updated`) — chat messages are private to their participants,
// unlike posts/comments. `chatId` is only ever set for a message reaction; it
// carries the chat the client needs to know which cached message list to
// patch (see patchCachedMessage in web/src/lib/chats.ts), since `targetId`
// alone (the message id) isn't enough to locate it client-side. Unlike the
// id-only events, this carries the fresh per-emoji counts so a viewer's
// counts update without every client having to refetch on every toggle — but
// never `reactedByMe`, which is inherently per-viewer and can't be baked into
// one broadcast payload shared by every recipient (each client's own reaction
// state is reconciled from its own mutation response instead — see
// EngagementHandler.ts/chats/messageHandlers.ts).
export type ReactionEvent = {
  readonly type: "reaction_changed";
  readonly targetType: "post" | "comment" | "message";
  readonly targetId: number;
  readonly chatId?: number;
  readonly reactions: ReadonlyArray<{
    readonly emoji: string;
    readonly count: number;
  }>;
};

// Pushed whenever a user's live-connection count transitions between zero and
// non-zero (see `register` below) — i.e. on their *first* connection (a tab
// opened, a page refreshed) or their *last* disconnection (every tab closed),
// not on every individual socket. Delivered only to the user's contacts (and
// the user's own other tabs) — see `notifyContacts` and PresenceAudience.ts —
// never broadcast: a global broadcast made presence O(online²) (issue #660).
export type PresenceEvent = {
  readonly type: "presence";
  readonly userId: number;
  readonly online: boolean;
};

// Who among a connecting user's contacts is online right now, written once
// straight to the new socket (see RealtimeSocket.ts) rather than as one
// `PresenceEvent` per online user. Replaces the client's whole presence set,
// so it doubles as the reset after a reconnect. Never published.
export type PresenceSnapshotEvent = {
  readonly type: "presence_snapshot";
  readonly userIds: ReadonlyArray<number>;
};

// Written by an instance to its own sockets when Redis is reachable again
// after an outage (issue #832): events between instances were lost
// meanwhile, so the client refetches what events keep current — the same
// self-heal it runs on every socket open — and gets a fresh
// `presence_snapshot` right after. Never published.
export type ResyncEvent = { readonly type: "resync" };

// Pushed when a message is pinned or unpinned chat-wide (issue #223). Scoped
// to the chat's participants (`notifyUsers`, like `chat_updated`/a message
// `reaction_changed`) rather than broadcast, since a chat and its pins are
// private to them. Carries the new `pinned` state so a viewer's badge and the
// pinned panel update without every client refetching on every toggle —
// clients patch the affected message's `pinned` flag in place and refresh the
// pinned list. Starring emits no event at all: a star is user-private (see
// pinsStars.ts), visible only to the user who created it, so there's nothing
// to fan out.
export type MessagePinEvent = {
  readonly type: "message_pin_changed";
  readonly chatId: number;
  readonly messageId: number;
  readonly pinned: boolean;
};

// Pushed to a chat's other participants while `userId` is composing a
// message in it (see `sendTyping` in chats/messageHandlers.ts). Purely
// transient — the server keeps no "is typing" state at all, so there's no
// corresponding "stopped typing" event; a client that stops receiving fresh
// pushes for a given chat/user pair is expected to expire the indicator
// client-side after a short timeout (see web/src/lib/typing.ts).
export type TypingEvent = {
  readonly type: "typing";
  readonly chatId: number;
  readonly userId: number;
  readonly username: string;
  readonly displayName: string | null;
};

// Pushed whenever someone sets/clears/updates their custom status (issue
// #218, see `updateStatus` in users/profileHandlers.ts) — to the same audience
// as `PresenceEvent` (their contacts and their own tabs, via `notifyContacts`).
// Anyone else sees the new status the next time they fetch the user. Carries
// the full, already-expiry-resolved state (see `effectiveStatus` in
// users/userViews.ts) so a client never needs a follow-up fetch to render it.
export type StatusEvent = {
  readonly type: "status_changed";
  readonly userId: number;
  readonly statusText: string | null;
  readonly statusEmoji: string | null;
  readonly statusExpiresAt: number | null;
};

// Pushed to a game lobby's room (see `notifyRoom` below — everyone currently
// viewing that lobby, players and spectators alike) whenever its membership,
// phase, or results change: someone joined/left, the host started a race or
// a rematch, a player crossed the finish line. Id-only like `post_changed` —
// clients refetch `GET /games/lobbies/:id` for the authoritative state.
export type GameLobbyEvent = {
  readonly type: "game_lobby_updated";
  readonly lobbyId: number;
};

// Pushed to a game's hub room (the lobby browser) whenever any of that
// game's lobbies is created, changes membership/phase, or disappears, so
// the open-lobbies list stays live without polling. Scoped to the hub room
// rather than `broadcastAll`, since only the handful of clients actually
// looking at the lobby browser care.
export type GameLobbiesEvent = {
  readonly type: "game_lobbies_changed";
  readonly game: string;
};

// A racer's live position, relayed to their lobby's room straight from the
// socket (see `game_progress` in RealtimeSocket.ts) — never persisted, and
// never trusted for scoring: `progress` is only what the opponents' lanes
// render, while the result that lands on the leaderboard is recomputed
// server-side from the finished text and the server's own clock (see
// GamesHandler.ts). `userId` is stamped by the server from the socket's
// authenticated identity, so a client can only ever move its own marker.
export type GameProgressEvent = {
  readonly type: "game_progress";
  readonly lobbyId: number;
  readonly userId: number;
  readonly progress: number;
};

// Pushed to a game lobby's room whenever someone says something in its chat
// (see `postGameChat` in games/lobbyChatHandlers.ts). Id-only — clients refetch
// `GET /games/lobbies/:id/chat`, which also drops authors they've blocked.
export type GameChatEvent = {
  readonly type: "game_chat";
  readonly lobbyId: number;
};

// An emoji reaction flung in a lobby, relayed to its room straight from the
// socket (see `game_reaction` in RealtimeSocket.ts) like `game_progress`:
// never persisted, `reaction` is one of the fixed `GAME_REACTIONS`, and
// `userId` is stamped by the server from the socket's own identity.
export type GameReactionEvent = {
  readonly type: "game_reaction";
  readonly lobbyId: number;
  readonly userId: number;
  readonly reaction: string;
};

// Pushed to one user (every tab they have open) whenever their notification
// inbox changes — a new notification landed, or they marked some read from
// another tab (issue #317, see src/notifications.ts). Carries nothing: the
// client refetches the unread count and, if open, the inbox.
export type NotificationsEvent = {
  readonly type: "notifications_changed";
};

// Event payloads mostly carry no data beyond an id — clients refetch the
// affected queries over the existing REST endpoints rather than trusting a
// duplicated copy of the state pushed over the socket. Presence/typing are
// the exception: there's no REST resource to refetch for "is this user
// currently online/typing", so those carry the full, self-contained state.
export type RealtimeEvent =
  | ChatEvent
  | ChatDeletedEvent
  | PostEvent
  | FeedHeadEvent
  | PostReactionsEvent
  | CommentEvent
  | ReactionEvent
  | MessagePinEvent
  | PresenceEvent
  | PresenceSnapshotEvent
  | ResyncEvent
  | TypingEvent
  | StatusEvent
  | GameLobbyEvent
  | GameLobbiesEvent
  | GameProgressEvent
  | GameChatEvent
  | GameReactionEvent
  | NotificationsEvent;

// A connected client's outbound channel — bound to one open `/ws` socket.
type Writer = (chunk: string) => Effect.Effect<void, unknown>;

// Closes one open `/ws` socket with an application close code (see
// `disconnectUser` and `drain`).
type Closer = (code: number, reason: string) => Effect.Effect<void, unknown>;

// The application close code a socket is closed with when its user's
// sessions were revoked (issue #651). The client reconnects as after any
// close, by minting a new ticket — which only a still-valid session can.
export const SESSION_REVOKED_CLOSE_CODE = 4401;

// The close code for a socket closed because this instance is shutting
// down (issue #836; see `drain`): reconnect, and you'll land elsewhere.
export const SERVER_DRAINING_CLOSE_CODE = 4503;

// Tracks which users currently have a live `/ws` connection, so:
//  - chat mutations can notify only the participants of the affected chat
//    (`notifyUsers`);
//  - post mutations can notify the sockets showing that post
//    (`notifyPostRoom`), and new posts the feed's viewers (`announcePost`).
export class RealtimeConnections extends Context.Service<
  RealtimeConnections,
  {
    // `close` is how `disconnectUser` ends this connection; a connection
    // registered without one is only ever dropped from delivery.
    readonly register: (
      userId: number,
      write: Writer,
      close?: Closer,
    ) => Effect.Effect<() => void>;
    readonly notifyUsers: (
      userIds: Iterable<number>,
      event: RealtimeEvent,
    ) => Effect.Effect<void>;
    // Every connected socket on every instance. Only for rare, genuinely
    // global events — never per item (a post, a reaction, a comment): those
    // happen in proportion to the number of users, so sending each to every
    // user is O(online²) (issue #828).
    readonly broadcastAll: (event: RealtimeEvent) => Effect.Effect<void>;
    // Closes every `/ws` connection `userId` has open, on every instance —
    // called wherever their token_version is bumped (log out everywhere,
    // password/role change, account deletion), since a socket is only
    // authenticated once, at its handshake, and would otherwise outlive the
    // sessions that opened it (issue #651).
    readonly disconnectUser: (userId: number) => Effect.Effect<void>;
    // Delivers `event` to `userId`'s contacts (see PresenceAudience.ts) and
    // to `userId`'s own sockets — the audience for anything that's a
    // property of the user rather than of a chat or post: presence and
    // status. Not `broadcastAll` (issue #660).
    readonly notifyContacts: (
      userId: number,
      event: RealtimeEvent,
    ) => Effect.Effect<void>;
    // Post-room subscription: a single `/ws` connection (identified by its
    // `write` channel) joining/leaving the set of sockets currently viewing
    // `postId`'s comment section. Membership is local to this instance — a
    // connection only lives on the instance that accepted it — so these just
    // mutate a local map; the *events* still travel over PubSub so a mutation
    // on any instance reaches that post's viewers on every instance (see
    // `notifyPostRoom`). A connection's `unregister` (from `register`) also
    // sweeps it out of every room, so a dropped socket needs no explicit
    // unsubscribe.
    readonly subscribePost: (
      postId: number,
      write: Writer,
    ) => Effect.Effect<void>;
    readonly unsubscribePost: (
      postId: number,
      write: Writer,
    ) => Effect.Effect<void>;
    // Publishes `event` to every socket subscribed to `postId`'s room, on any
    // instance — the scoped counterpart to `broadcastAll`, for comment/reply
    // and per-comment-like activity that shouldn't flood the whole feed.
    readonly notifyPostRoom: (
      postId: number,
      event: RealtimeEvent,
    ) => Effect.Effect<void>;
    // A connection showing a post (a card) rather than its comments (issue
    // #828). Watchers get the post's own changes — `notifyPostViewers` and
    // `post_reactions` — but not its comment traffic, which only open
    // comment sections need. Local bookkeeping, like `subscribePost`.
    readonly watchPost: (postId: number, write: Writer) => Effect.Effect<void>;
    readonly unwatchPost: (
      postId: number,
      write: Writer,
    ) => Effect.Effect<void>;
    // `event` to every socket showing `postId` — its watchers and its
    // comment room — on any instance. For a post's own edit or deletion.
    readonly notifyPostViewers: (
      postId: number,
      event: RealtimeEvent,
    ) => Effect.Effect<void>;
    // A post's new reaction counts, batched into its viewers' next
    // `post_reactions` frame on every instance (see PostReactionsEvent).
    readonly announcePostReactions: (
      postId: number,
      reactions: PostReactionsEvent["posts"][number]["reactions"],
    ) => Effect.Effect<void>;
    // Ids of `userId`'s contacts with a live `/ws` connection *anywhere*
    // right now (PresenceStore answers the "anywhere" part — correctly
    // cross-instance when Redis-backed). Used to hand a freshly-connecting
    // client its initial `presence_snapshot` (see RealtimeSocket.ts) — after
    // that, live transitions arrive as `PresenceEvent`s via
    // `notifyContacts`. Costs O(contacts), not O(everyone online).
    readonly onlineContactIds: (
      userId: number,
    ) => Effect.Effect<ReadonlyArray<number>>;
    // Called after `newUserIds` joined a chat whose members are now
    // `memberIds` (issue #684). Presence only reaches contacts, and the
    // audience is worked out when a presence event is sent or a socket
    // opens — so two users who just *became* contacts would see each other
    // offline until one of them reconnected. This sends `presence: online`
    // both ways for every newcomer/member pair where both are online and
    // neither has blocked the other. Redundant for a pair that were already
    // contacts through another chat, which is harmless: the client only
    // reacts to a change (see web/src/lib/presence.ts).
    readonly introduceContacts: (
      newUserIds: Iterable<number>,
      memberIds: Iterable<number>,
    ) => Effect.Effect<void>;
    // Named rooms — the generalized form of the post rooms above, used by
    // the games feature (`game-hub:<game>` for a lobby browser,
    // `game-lobby:<id>` for one lobby; see `isValidRoomName`). Same
    // local-membership/PubSub-delivery split as `subscribePost`/
    // `notifyPostRoom`, and likewise swept on `unregister`.
    readonly subscribeRoom: (
      room: string,
      write: Writer,
    ) => Effect.Effect<void>;
    readonly unsubscribeRoom: (
      room: string,
      write: Writer,
    ) => Effect.Effect<void>;
    // Whether this specific connection has joined `room` on this instance —
    // lets RealtimeSocket.ts only relay a socket's `game_progress` into a
    // lobby it's actually watching.
    readonly isInRoom: (room: string, write: Writer) => Effect.Effect<boolean>;
    readonly notifyRoom: (
      room: string,
      event: RealtimeEvent,
    ) => Effect.Effect<void>;
    // Shutting down (issue #836): closes every connection on this instance
    // with SERVER_DRAINING_CLOSE_CODE, each at a random moment within
    // `window`, and resolves once all have been closed. Every client on a
    // stopping instance used to be dropped at the same instant, and their
    // reconnects and refetches all landed on the shared database at once —
    // one restart slowed the whole cluster. Spread out, a restart costs
    // what its reconnects cost, over `window`. Also flips `isDraining`.
    readonly drain: (window: Duration.Duration) => Effect.Effect<void>;
    // Whether `drain` has started — new `/ws` upgrades are refused then.
    readonly isDraining: Effect.Effect<boolean>;
    // A new post: feed viewers on every instance hear about it in their
    // next coalesced `feed_head` (see `FeedHeadEvent`).
    readonly announcePost: (postId: number) => Effect.Effect<void>;
  }
>()("RealtimeConnections") {}

// Room names a client may subscribe to over `/ws`. An allowlist rather than
// "any string", so a client can't grow the room map without bound with
// made-up names. The feed (see `FeedHeadEvent`) and the games; the game
// segment is a lowercase slug so a new game (see GAMES in Api.ts) needs no
// change here.
const ROOM_NAME_PATTERN =
  /^(feed|game-hub:[a-z][a-z0-9-]{0,31}|game-lobby:\d{1,10})$/;

// The room a client joins while it shows the feed, for `feed_head`.
export const FEED_ROOM = "feed";

// How often an instance may tell its feed viewers about new posts. Each
// tick sends at most one `feed_head`, so feed traffic is one frame per
// viewer per interval, not one per viewer per post. A reference so tests
// can shorten it.
export const FeedHeadInterval = Context.Reference<Duration.Duration>(
  "chat-platform/Realtime/FeedHeadInterval",
  { defaultValue: () => Duration.seconds(3) },
);

// How often an instance sends its sockets the posts' latest reaction counts
// (see PostReactionsEvent). A reference so tests can shorten it.
export const PostReactionsInterval = Context.Reference<Duration.Duration>(
  "chat-platform/Realtime/PostReactionsInterval",
  { defaultValue: () => Duration.seconds(2) },
);

// How long after Redis comes back an instance spreads its sockets'
// `resync`s over (see ResyncEvent), so their refetches and presence
// snapshots don't all land on the database at once. A reference so tests
// can shorten it.
export const ResyncSpread = Context.Reference<Duration.Duration>(
  "chat-platform/Realtime/ResyncSpread",
  { defaultValue: () => Duration.seconds(10) },
);

// The most ids one `feed_head` carries; older ones in a burst are dropped,
// since the client only needs to know there's something to fetch.
export const MAX_FEED_HEAD_POST_IDS = 20;

// How many post comment rooms / named rooms one connection may be in at
// once. A real client is in a handful (the comment sections open on screen;
// a games hub and a lobby) — the caps only stop a scripted socket from
// joining millions. Joins past a cap are dropped silently, like any other
// malformed control message.
export const MAX_POST_ROOMS_PER_CONNECTION = 200;
// Cards one connection may watch at once (see `watchPost`) — a long-scrolled
// feed stays well inside it; joins past it are dropped like the others.
export const MAX_WATCHED_POSTS_PER_CONNECTION = 200;
export const MAX_ROOMS_PER_CONNECTION = 32;

export const isValidRoomName = (room: unknown): room is string =>
  typeof room === "string" && ROOM_NAME_PATTERN.test(room);

export const gameLobbyRoom = (lobbyId: number): string =>
  `game-lobby:${lobbyId}`;

export const gameHubRoom = (game: string): string => `game-hub:${game}`;

// The channel every RealtimeConnectionsLive instance publishes to and
// subscribes on — one process-wide topic is enough since each message
// already carries its own targeting (see Envelope).
const CHANNEL = "chat-platform:realtime";

// Each instance also listens on its own channel, for events addressed to
// users it holds (issue #832; see `routeToUsers`).
const INSTANCE_CHANNEL_PREFIX = "chat-platform:realtime:instance:";

// A routed user event's copy on the shared channel, for instances that
// predate routing (mid-rollout) and only listen there. It starts with this
// so current instances can skip it without parsing it.
const ROUTED_COPY_PREFIX = '{"routed":true,';

type Envelope =
  | {
      readonly scope: "users";
      readonly userIds: ReadonlyArray<number>;
      readonly event: RealtimeEvent;
    }
  | { readonly scope: "all"; readonly event: RealtimeEvent }
  | {
      readonly scope: "post";
      readonly postId: number;
      readonly event: RealtimeEvent;
    }
  | {
      readonly scope: "room";
      readonly room: string;
      readonly event: RealtimeEvent;
    }
  | { readonly scope: "disconnect"; readonly userId: number }
  // A new post, for every instance's next `feed_head` (see `announcePost`).
  | { readonly scope: "feed_post"; readonly postId: number }
  // A post's own change, for everyone showing it (see `notifyPostViewers`).
  | {
      readonly scope: "post_viewers";
      readonly postId: number;
      readonly event: RealtimeEvent;
    }
  // A post's latest reaction counts (see `announcePostReactions`).
  | {
      readonly scope: "post_reactions";
      readonly postId: number;
      readonly reactions: PostReactionsEvent["posts"][number]["reactions"];
    };

// Registration (`byUser`) stays local to this process — a `/ws` connection
// only ever lives on the instance that accepted it, and `byUser` exists only
// to know which local writers to call when a message needs delivering here —
// but delivery goes through PubSub (see PubSub.ts) so that a mutation
// handled by *any* instance reaches participants connected to *any other*
// instance too, not just the one that happened to process the mutation.
// Whether a *user* (as opposed to one specific connection) is online is a
// separate question, answered by PresenceStore (see Presence.ts) rather than
// by the size of this instance's own local `byUser` entry.
export const RealtimeConnectionsLive = Layer.effect(
  RealtimeConnections,
  Effect.gen(function* () {
    const pubsub = yield* PubSub;
    const locator = yield* UserLocator;
    const instanceId = crypto.randomUUID();
    const instanceChannel = `${INSTANCE_CHANNEL_PREFIX}${instanceId}`;
    // Whether routed user events are also copied to the shared channel, for
    // instances that predate routing. On by default so a rolling deploy
    // loses nothing; turn off once every instance runs this code.
    const legacyBroadcast = yield* Config.Boolean(
      "REALTIME_LEGACY_BROADCAST",
    ).pipe(Config.withDefault(true));
    const presenceStore = yield* PresenceStore;
    const audience = yield* PresenceAudience;
    const byUser = new Map<number, Set<Writer>>();
    // Each local connection's `close` handle (see `register`), for
    // `disconnectUser`.
    const closers = new Map<Writer, Closer>();
    // postId -> the local connection writers currently subscribed to that
    // post's comment room (see `subscribePost`). Parallel to `byUser`, and
    // like it stays local per-instance — cross-instance fan-out is PubSub's
    // job (see `notifyPostRoom`).
    const byPost = new Map<number, Set<Writer>>();
    // postId -> local connections showing it as a card (see `watchPost`).
    const byWatchedPost = new Map<number, Set<Writer>>();
    // room name -> local connection writers subscribed to it (see
    // `subscribeRoom`). Same local-only bookkeeping as `byPost`.
    const byRoom = new Map<string, Set<Writer>>();
    // The reverse of `byPost`/`byRoom`: what each connection has joined. It
    // caps how much one socket can join (room names and post ids come
    // straight off the wire, so without it a single client could grow the
    // maps above without bound), and lets a disconnect sweep only its own
    // memberships instead of every room on the instance.
    const joined = new Map<
      Writer,
      { posts: Set<number>; watching: Set<number>; rooms: Set<string> }
    >();
    const joinedBy = (write: Writer) => {
      let entry = joined.get(write);
      if (!entry) {
        entry = { posts: new Set(), watching: new Set(), rooms: new Set() };
        joined.set(write, entry);
      }
      return entry;
    };

    // A dead/broken socket write must never fail the mutation that triggered
    // it (same reasoning as notifyUsers/broadcastAll's Effect.ignore below),
    // but silently dropping it left no trace a connection had gone bad.
    // Logging here at least leaves a trail. `context` identifies the intended
    // recipient (a `userId` for user/broadcast scopes, a `postId` for a post
    // room) for the log line.
    const logDroppedWrite = (
      context: Record<string, unknown>,
      error: unknown,
    ) =>
      Effect.logWarning(
        "RealtimeConnections: dropped delivery, connection write failed",
      ).pipe(Effect.annotateLogs({ ...context, error: String(error) }));

    const writeAll = (
      writers: Iterable<Writer>,
      payload: string,
      context: Record<string, unknown>,
    ) =>
      Effect.gen(function* () {
        for (const write of writers) {
          yield* write(payload).pipe(
            Effect.catch((error) => logDroppedWrite(context, error)),
          );
        }
      });

    // Everyone on this instance showing `postId`: its card watchers and its
    // open comment sections, each connection once.
    const viewersOf = (postId: number): Set<Writer> =>
      new Set([
        ...(byWatchedPost.get(postId) ?? []),
        ...(byPost.get(postId) ?? []),
      ]);

    // postId -> latest reaction counts not yet sent (see the ticker below).
    // Newer counts replace older ones: each carries the full state.
    const pendingPostReactions = new Map<
      number,
      PostReactionsEvent["posts"][number]["reactions"]
    >();

    // Posts announced since this instance's last `feed_head` (see
    // `announcePost` and the ticker below), newest last.
    const pendingFeedPosts: number[] = [];

    const countUserEnvelope = (
      channel: "instance" | "shared",
      outcome: "delivered" | "no_local_recipients" | "skipped_routed_copy",
    ) =>
      Metric.update(
        Metric.withAttributes(realtimeUserEnvelopesTotal, { channel, outcome }),
        1,
      );

    const deliverLocally = (
      message: string,
      channel: "instance" | "shared" = "shared",
    ) =>
      Effect.gen(function* () {
        const envelope = JSON.parse(message) as Envelope;

        if (envelope.scope === "disconnect") {
          const writers = byUser.get(envelope.userId);
          yield* countUserEnvelope(
            channel,
            writers ? "delivered" : "no_local_recipients",
          );
          if (!writers) return;
          // Out of delivery right away rather than once the close lands, so
          // nothing more reaches a revoked socket in between. The socket's
          // own `unregister` still runs when its read loop ends — but finds
          // the user already gone, so the claim is released here.
          byUser.delete(envelope.userId);
          yield* locator.release(envelope.userId, instanceId);
          for (const write of writers) {
            const close = closers.get(write);
            if (!close) continue;
            yield* close(SESSION_REVOKED_CLOSE_CODE, "Session revoked").pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "RealtimeConnections: failed to close a revoked connection",
                ).pipe(
                  Effect.annotateLogs({
                    userId: envelope.userId,
                    error: String(error),
                  }),
                ),
              ),
            );
          }
          return;
        }

        if (envelope.scope === "post_reactions") {
          pendingPostReactions.set(envelope.postId, envelope.reactions);
          return;
        }

        if (envelope.scope === "feed_post") {
          pendingFeedPosts.push(envelope.postId);
          if (pendingFeedPosts.length > MAX_FEED_HEAD_POST_IDS) {
            pendingFeedPosts.shift();
          }
          return;
        }

        const payload = JSON.stringify(envelope.event);

        if (envelope.scope === "all") {
          for (const [userId, writers] of byUser) {
            yield* writeAll(writers, payload, { userId });
          }
          return;
        }

        if (envelope.scope === "post") {
          const writers = byPost.get(envelope.postId);
          if (!writers) return;
          yield* writeAll(writers, payload, { postId: envelope.postId });
          return;
        }

        if (envelope.scope === "post_viewers") {
          yield* writeAll(viewersOf(envelope.postId), payload, {
            postId: envelope.postId,
          });
          return;
        }

        if (envelope.scope === "room") {
          const writers = byRoom.get(envelope.room);
          if (!writers) return;
          yield* writeAll(writers, payload, { room: envelope.room });
          return;
        }

        const seen = new Set<number>();
        let delivered = false;
        for (const userId of envelope.userIds) {
          if (seen.has(userId)) continue;
          seen.add(userId);
          const writers = byUser.get(userId);
          if (!writers) continue;
          delivered = true;
          yield* writeAll(writers, payload, { userId });
        }
        yield* countUserEnvelope(
          channel,
          delivered ? "delivered" : "no_local_recipients",
        );
      });

    yield* pubsub.subscribe(CHANNEL, (message) =>
      message.startsWith(ROUTED_COPY_PREFIX)
        ? countUserEnvelope("shared", "skipped_routed_copy")
        : deliverLocally(message, "shared"),
    );
    yield* pubsub.subscribe(instanceChannel, (message) =>
      deliverLocally(message, "instance"),
    );
    yield* forkClaimRefresher(locator, instanceId, () => [...byUser.keys()]);

    // Flushes `pendingFeedPosts` to this instance's feed viewers, at most
    // once per interval (see `FeedHeadEvent`). Runs on every instance, each
    // for its own sockets, off the same `feed_post` envelopes.
    const flushFeedHead = Effect.gen(function* () {
      if (pendingFeedPosts.length === 0) return;
      const postIds = pendingFeedPosts.splice(0);
      const writers = byRoom.get(FEED_ROOM);
      if (!writers) return;
      yield* writeAll(
        writers,
        JSON.stringify({ type: "feed_head", postIds } satisfies FeedHeadEvent),
        { room: FEED_ROOM },
      );
    });
    // Sends each local socket one `post_reactions` frame with every pending
    // post it shows, then forgets them (see PostReactionsEvent).
    const flushPostReactions = Effect.gen(function* () {
      if (pendingPostReactions.size === 0) return;
      const byWriter = new Map<Writer, PostReactionsEvent["posts"][number][]>();
      for (const [postId, reactions] of pendingPostReactions) {
        for (const write of viewersOf(postId)) {
          const posts = byWriter.get(write) ?? [];
          posts.push({ postId, reactions });
          byWriter.set(write, posts);
        }
      }
      pendingPostReactions.clear();
      for (const [write, posts] of byWriter) {
        yield* write(
          JSON.stringify({
            type: "post_reactions",
            posts,
          } satisfies PostReactionsEvent),
        ).pipe(
          Effect.catch((error) =>
            logDroppedWrite({ scope: "post_reactions" }, error),
          ),
        );
      }
    });
    const postReactionsInterval = yield* PostReactionsInterval;
    yield* Effect.forkScoped(
      flushPostReactions.pipe(
        Effect.repeat(Schedule.spaced(postReactionsInterval)),
      ),
    );

    const feedHeadInterval = yield* FeedHeadInterval;
    yield* Effect.forkScoped(
      flushFeedHead.pipe(Effect.repeat(Schedule.spaced(feedHeadInterval))),
    );

    // Best-effort, like the local delivery it replaces: a mutation
    // succeeding shouldn't fail just because the realtime push couldn't be
    // published (e.g. Redis briefly unreachable). Logged rather than plain
    // `Effect.ignore`d so a publish failure — which drops the event for
    // every instance, not just this one — leaves a trail.
    const logPublishFailure = (envelope: Envelope, error: unknown) =>
      Effect.logWarning(
        "RealtimeConnections: failed to publish realtime event, delivery dropped",
      ).pipe(Effect.annotateLogs({ envelope, error: String(error) }));

    // Publishes a user-addressed envelope only to the instances holding
    // those users (issue #832), each copy carrying just that instance's
    // recipients — an offline user costs no publish at all. If the
    // directory can't be read, it goes on the shared channel as it always
    // did, so a Redis hiccup degrades to the old cost, not to lost events.
    // With `legacyBroadcast`, a marked copy also goes on the shared channel
    // for instances that predate routing (current ones skip it unparsed).
    const routeToUsers = (
      userIds: Iterable<number>,
      envelopeFor: (ids: ReadonlyArray<number>) => Envelope,
    ) =>
      Effect.gen(function* () {
        const ids = [...new Set(userIds)];
        if (ids.length === 0) return;
        const publish = (channel: string, envelope: Envelope, body: string) =>
          pubsub
            .publish(channel, body)
            .pipe(Effect.catch((error) => logPublishFailure(envelope, error)));
        const located = yield* locator.locate(ids);
        if (located === null) {
          const envelope = envelopeFor(ids);
          yield* publish(CHANNEL, envelope, JSON.stringify(envelope));
          return;
        }
        for (const [instance, instanceIds] of located) {
          const envelope = envelopeFor(instanceIds);
          yield* publish(
            `${INSTANCE_CHANNEL_PREFIX}${instance}`,
            envelope,
            JSON.stringify(envelope),
          );
        }
        if (legacyBroadcast) {
          const envelope = envelopeFor(ids);
          yield* publish(
            CHANNEL,
            envelope,
            `${ROUTED_COPY_PREFIX}${JSON.stringify(envelope).slice(1)}`,
          );
        }
      });

    const notifyUsers: RealtimeConnections["Service"]["notifyUsers"] = (
      userIds,
      event,
    ) =>
      routeToUsers(userIds, (ids) => ({
        scope: "users",
        userIds: ids,
        event,
      }));

    const broadcastAll: RealtimeConnections["Service"]["broadcastAll"] = (
      event,
    ) => {
      const envelope = { scope: "all", event } satisfies Envelope;
      return pubsub
        .publish(CHANNEL, JSON.stringify(envelope))
        .pipe(Effect.catch((error) => logPublishFailure(envelope, error)));
    };

    const disconnectUser: RealtimeConnections["Service"]["disconnectUser"] = (
      userId,
    ) => routeToUsers([userId], () => ({ scope: "disconnect", userId }));

    const notifyContacts: RealtimeConnections["Service"]["notifyContacts"] = (
      userId,
      event,
    ) =>
      audience
        .contactsOf(userId)
        .pipe(
          Effect.flatMap((contacts) =>
            notifyUsers([userId, ...contacts], event),
          ),
        );

    const notifyPostRoom: RealtimeConnections["Service"]["notifyPostRoom"] = (
      postId,
      event,
    ) => {
      const envelope = { scope: "post", postId, event } satisfies Envelope;
      return pubsub
        .publish(CHANNEL, JSON.stringify(envelope))
        .pipe(Effect.catch((error) => logPublishFailure(envelope, error)));
    };

    const subscribePost: RealtimeConnections["Service"]["subscribePost"] = (
      postId,
      write,
    ) =>
      Effect.sync(() => {
        const mine = joinedBy(write).posts;
        if (!mine.has(postId) && mine.size >= MAX_POST_ROOMS_PER_CONNECTION) {
          return;
        }
        mine.add(postId);
        const set = byPost.get(postId) ?? new Set();
        set.add(write);
        byPost.set(postId, set);
      });

    const unsubscribePost: RealtimeConnections["Service"]["unsubscribePost"] = (
      postId,
      write,
    ) =>
      Effect.sync(() => {
        joined.get(write)?.posts.delete(postId);
        const set = byPost.get(postId);
        if (!set) return;
        set.delete(write);
        if (set.size === 0) byPost.delete(postId);
      });

    const watchPost: RealtimeConnections["Service"]["watchPost"] = (
      postId,
      write,
    ) =>
      Effect.sync(() => {
        const mine = joinedBy(write).watching;
        if (
          !mine.has(postId) &&
          mine.size >= MAX_WATCHED_POSTS_PER_CONNECTION
        ) {
          return;
        }
        mine.add(postId);
        const set = byWatchedPost.get(postId) ?? new Set();
        set.add(write);
        byWatchedPost.set(postId, set);
      });

    const unwatchPost: RealtimeConnections["Service"]["unwatchPost"] = (
      postId,
      write,
    ) =>
      Effect.sync(() => {
        joined.get(write)?.watching.delete(postId);
        const set = byWatchedPost.get(postId);
        if (!set) return;
        set.delete(write);
        if (set.size === 0) byWatchedPost.delete(postId);
      });

    const notifyPostViewers: RealtimeConnections["Service"]["notifyPostViewers"] =
      (postId, event) => {
        const envelope = {
          scope: "post_viewers",
          postId,
          event,
        } satisfies Envelope;
        return pubsub
          .publish(CHANNEL, JSON.stringify(envelope))
          .pipe(Effect.catch((error) => logPublishFailure(envelope, error)));
      };

    const announcePostReactions: RealtimeConnections["Service"]["announcePostReactions"] =
      (postId, reactions) => {
        const envelope = {
          scope: "post_reactions",
          postId,
          reactions,
        } satisfies Envelope;
        return pubsub
          .publish(CHANNEL, JSON.stringify(envelope))
          .pipe(Effect.catch((error) => logPublishFailure(envelope, error)));
      };

    const notifyRoom: RealtimeConnections["Service"]["notifyRoom"] = (
      room,
      event,
    ) => {
      const envelope = { scope: "room", room, event } satisfies Envelope;
      return pubsub
        .publish(CHANNEL, JSON.stringify(envelope))
        .pipe(Effect.catch((error) => logPublishFailure(envelope, error)));
    };

    const subscribeRoom: RealtimeConnections["Service"]["subscribeRoom"] = (
      room,
      write,
    ) =>
      Effect.sync(() => {
        const mine = joinedBy(write).rooms;
        if (!mine.has(room) && mine.size >= MAX_ROOMS_PER_CONNECTION) return;
        mine.add(room);
        const set = byRoom.get(room) ?? new Set();
        set.add(write);
        byRoom.set(room, set);
      });

    const unsubscribeRoom: RealtimeConnections["Service"]["unsubscribeRoom"] = (
      room,
      write,
    ) =>
      Effect.sync(() => {
        joined.get(write)?.rooms.delete(room);
        const set = byRoom.get(room);
        if (!set) return;
        set.delete(write);
        if (set.size === 0) byRoom.delete(room);
      });

    const isInRoom: RealtimeConnections["Service"]["isInRoom"] = (
      room,
      write,
    ) => Effect.sync(() => byRoom.get(room)?.has(write) ?? false);

    const register: RealtimeConnections["Service"]["register"] = (
      userId,
      write,
      close,
    ) =>
      Effect.gen(function* () {
        const set = byUser.get(userId) ?? new Set();
        // This instance's first socket for the user: tell the directory, so
        // events for them are routed here (issue #832).
        if (set.size === 0) yield* locator.claim(userId, instanceId);
        set.add(write);
        byUser.set(userId, set);
        if (close) closers.set(write, close);
        // One live `/ws` socket on this instance, for VictoriaMetrics'
        // `websocket_connections_active` gauge (see Metrics.ts) — a count of
        // *connections*, not of online *users* (PresenceStore, below, is the
        // latter): a user with two tabs open holds two of these.
        yield* Metric.modify(websocketConnectionsActive, 1);
        // Churn counterpart to the gauge above — websocketConnectionsActive
        // only shows the current count, not how often connections open and
        // close.
        yield* Metric.update(
          Metric.withAttributes(websocketConnectionsTotal, {
            event: "connect",
          }),
          1,
        );
        // PresenceStore.connect reports whether this was the *global*
        // transition to online (across every instance), not just whether
        // this instance's own local set was empty a moment ago — a second
        // tab landing on a different instance must not re-announce a user
        // who's already online via the first.
        const cameOnline = yield* presenceStore.connect(userId);
        if (cameOnline) {
          yield* notifyContacts(userId, {
            type: "presence",
            userId,
            online: true,
          });
        }
        return () => {
          const current = byUser.get(userId);
          if (current) {
            current.delete(write);
            if (current.size === 0) {
              byUser.delete(userId);
              Effect.runFork(locator.release(userId, instanceId));
            }
          }
          closers.delete(write);
          // Sweep this connection out of every post and named room it had
          // joined, so a dropped socket leaves no dangling room membership
          // (the client has no chance to send `unsubscribe_post_comments` on
          // an abrupt close).
          const mine = joined.get(write);
          joined.delete(write);
          for (const postId of mine?.posts ?? []) {
            const writers = byPost.get(postId);
            if (writers?.delete(write) && writers.size === 0) {
              byPost.delete(postId);
            }
          }
          for (const postId of mine?.watching ?? []) {
            const writers = byWatchedPost.get(postId);
            if (writers?.delete(write) && writers.size === 0) {
              byWatchedPost.delete(postId);
            }
          }
          for (const room of mine?.rooms ?? []) {
            const writers = byRoom.get(room);
            if (writers?.delete(write) && writers.size === 0) {
              byRoom.delete(room);
            }
          }
          Effect.runFork(Metric.modify(websocketConnectionsActive, -1));
          Effect.runFork(
            Metric.update(
              Metric.withAttributes(websocketConnectionsTotal, {
                event: "disconnect",
              }),
              1,
            ),
          );
          // Called from a plain sync cleanup callback
          // (`Effect.ensuring(Effect.sync(unregister))` in
          // RealtimeSocket.ts), which can't itself `yield*` — same
          // `runFork` idiom PubSub.ts's `subscribe` uses to bridge an
          // Effect into a non-Effect callback. Always tells PresenceStore
          // about the disconnect (even if this user had other local
          // connections left on *this* instance) — it's the one that knows
          // whether any connection, anywhere, is still holding them online.
          Effect.runFork(
            presenceStore.disconnect(userId).pipe(
              Effect.flatMap((wentOffline) =>
                wentOffline
                  ? notifyContacts(userId, {
                      type: "presence",
                      userId,
                      online: false,
                    })
                  : Effect.void,
              ),
            ),
          );
        };
      });

    const onlineContactIds: RealtimeConnections["Service"]["onlineContactIds"] =
      (userId) =>
        audience
          .contactsOf(userId)
          .pipe(
            Effect.flatMap((contacts) => presenceStore.onlineAmong(contacts)),
          );

    const introduceContacts: RealtimeConnections["Service"]["introduceContacts"] =
      (newUserIds, memberIds) =>
        Effect.gen(function* () {
          const members = new Set(memberIds);
          const newcomers = [...new Set(newUserIds)];
          // Only a pair that's online on both ends needs telling — anyone
          // offline is already shown as offline.
          const online = new Set(
            yield* presenceStore.onlineAmong([
              ...new Set([...members, ...newcomers]),
            ]),
          );
          const introduced = new Set<number>();
          for (const userId of newcomers) {
            if (!online.has(userId)) continue;
            introduced.add(userId);
            // `contactsOf` reads the membership that just committed, and
            // drops anyone on either side of a block.
            const contacts = (yield* audience.contactsOf(userId)).filter(
              (other) =>
                members.has(other) &&
                online.has(other) &&
                // Two newcomers introduce each other once, not twice.
                !introduced.has(other),
            );
            if (contacts.length === 0) continue;
            yield* notifyUsers(contacts, {
              type: "presence",
              userId,
              online: true,
            });
            for (const other of contacts) {
              yield* notifyUsers([userId], {
                type: "presence",
                userId: other,
                online: true,
              });
            }
          }
        });

    const announcePost: RealtimeConnections["Service"]["announcePost"] = (
      postId,
    ) => {
      const envelope = { scope: "feed_post", postId } satisfies Envelope;
      return pubsub
        .publish(CHANNEL, JSON.stringify(envelope))
        .pipe(Effect.catch((error) => logPublishFailure(envelope, error)));
    };

    // Presence the store found out about on its own (issue #837): users
    // whose connections were all on an instance that died, and users back
    // after this instance was wrongly reaped.
    yield* presenceStore.onPresenceChange((changes) =>
      Effect.forEach(
        changes,
        ({ userId, online }) =>
          notifyContacts(userId, { type: "presence", userId, online }),
        { discard: true },
      ),
    );

    let draining = false;
    const isDraining = Effect.sync(() => draining);
    const drain: RealtimeConnections["Service"]["drain"] = (window) =>
      Effect.gen(function* () {
        draining = true;
        const windowMs = Duration.toMillis(window);
        yield* Effect.forEach(
          [...closers.values()],
          (close) =>
            Effect.sleep(Duration.millis(Math.random() * windowMs)).pipe(
              Effect.andThen(
                close(SERVER_DRAINING_CLOSE_CODE, "Server restarting"),
              ),
              Effect.ignore,
            ),
          { concurrency: "unbounded", discard: true },
        );
      });

    // Redis back after an outage (issue #832; see ResyncEvent): every
    // socket here missed whatever other instances published meanwhile.
    // Each user gets a `resync` and a fresh presence snapshot at a random
    // moment within `ResyncSpread`.
    const resyncSpread = yield* ResyncSpread;
    const resyncUser = (userId: number) =>
      Effect.gen(function* () {
        const writers = byUser.get(userId);
        if (!writers) return;
        yield* writeAll(writers, JSON.stringify({ type: "resync" }), {
          userId,
        });
        const online = yield* onlineContactIds(userId);
        const snapshot: PresenceSnapshotEvent = {
          type: "presence_snapshot",
          userIds: [userId, ...online],
        };
        yield* writeAll(byUser.get(userId) ?? [], JSON.stringify(snapshot), {
          userId,
        });
      });
    yield* pubsub.onReconnect(
      Effect.suspend(() => {
        const spreadMs = Duration.toMillis(resyncSpread);
        return Effect.forEach(
          [...byUser.keys()],
          (userId) =>
            Effect.sleep(Duration.millis(Math.random() * spreadMs)).pipe(
              Effect.andThen(resyncUser(userId)),
              Effect.ignore,
            ),
          { concurrency: "unbounded", discard: true },
        );
      }),
    );

    return {
      register,
      notifyUsers,
      broadcastAll,
      announcePost,
      disconnectUser,
      notifyContacts,
      subscribePost,
      unsubscribePost,
      watchPost,
      unwatchPost,
      notifyPostViewers,
      announcePostReactions,
      notifyPostRoom,
      onlineContactIds,
      introduceContacts,
      subscribeRoom,
      unsubscribeRoom,
      isInRoom,
      notifyRoom,
      drain,
      isDraining,
    };
  }),
);
