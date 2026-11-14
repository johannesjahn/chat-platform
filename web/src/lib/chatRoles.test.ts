/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { canManageChat, canManageChatRoles, chatRoleOf } from "./chatRoles";

const chat = {
  participants: [
    { userId: 1, role: "owner" as const },
    { userId: 2, role: "admin" as const },
    { userId: 3, role: "member" as const },
  ],
};
const user = (id: number, role = "user") => ({ id, role });

describe("chat roles", () => {
  test("chatRoleOf reads the viewer's per-chat role", () => {
    expect(chatRoleOf(chat, 1)).toBe("owner");
    expect(chatRoleOf(chat, 3)).toBe("member");
    expect(chatRoleOf(chat, 9)).toBeUndefined();
  });

  test("owners, chat admins and site admins can manage", () => {
    expect(canManageChat(chat, user(1))).toBe(true);
    expect(canManageChat(chat, user(2))).toBe(true);
    expect(canManageChat(chat, user(3))).toBe(false);
    expect(canManageChat(chat, user(3, "admin"))).toBe(true);
    expect(canManageChat(chat, user(9))).toBe(false);
  });

  test("only the owner or a site admin manages roles", () => {
    expect(canManageChatRoles(chat, user(1))).toBe(true);
    expect(canManageChatRoles(chat, user(2))).toBe(false);
    expect(canManageChatRoles(chat, user(3, "admin"))).toBe(true);
  });
});
