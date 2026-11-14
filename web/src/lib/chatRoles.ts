// Who may do what in a chat, as the client shows it — mirrors the backend's
// guards in src/chats/access.ts (`requireChatManager`/`requireChatOwner`), so
// the UI only offers what the server will allow. Shared by the conversation
// and the group settings (issue #811); no imports, so it stays testable and
// out of the way of the bundle.
type ChatRole = "owner" | "admin" | "member";

type ChatWithRoles = {
  readonly participants: ReadonlyArray<{
    readonly userId: number;
    readonly role: ChatRole;
  }>;
};

type Viewer = { readonly id: number; readonly role: string };

// The viewer's per-chat role (issue #220), or undefined if they're not in it.
export function chatRoleOf(
  chat: ChatWithRoles,
  userId: number,
): ChatRole | undefined {
  return chat.participants.find((p) => p.userId === userId)?.role;
}

// The chat's owner or admin, or a site-wide admin — a site admin only reaches
// this UI at all once they're a participant, since `getChat` requires that.
export function canManageChat(chat: ChatWithRoles, viewer: Viewer): boolean {
  const role = chatRoleOf(chat, viewer.id);
  return role === "owner" || role === "admin" || viewer.role === "admin";
}

// Promoting/demoting is the owner's (or a site admin's) alone.
export function canManageChatRoles(
  chat: ChatWithRoles,
  viewer: Viewer,
): boolean {
  return chatRoleOf(chat, viewer.id) === "owner" || viewer.role === "admin";
}
