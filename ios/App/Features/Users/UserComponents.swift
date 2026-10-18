import ChatAPI
import SwiftUI

/// Someone's custom status (emoji + text), read through `UserStore` so a
/// realtime `status_changed` shows at once; renders nothing when unset, and
/// disappears by itself when it expires.
struct UserStatusBadge: View {
    @Environment(AppEnvironment.self) private var env
    let userId: Int
    var font: Font = .subheadline
    var showsExpiry = false
    var identifier: String?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if let status = env.users.status(of: userId, now: context.date) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        if let emoji = status.emoji { Text(emoji) }
                        if let text = status.text { Text(text).lineLimit(2) }
                    }
                    .font(font)
                    if showsExpiry, let expires = status.expiresAt {
                        Text("Clears \(Date(timeIntervalSince1970: TimeInterval(expires) / 1000), format: .relative(presentation: .named))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Status: \([status.emoji, status.text].compactMap(\.self).joined(separator: " "))")
                .accessibilityIdentifier(identifier ?? "")
            }
        }
    }
}

/// One person in a list: avatar, name, handle and status.
struct UserRowLabel: View {
    @Environment(AppEnvironment.self) private var env
    let userId: Int

    var body: some View {
        let user = env.users.user(userId)
        HStack(spacing: 12) {
            AvatarView(userId: userId, size: 40, showsPresence: true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(user?.label ?? "…").font(.body.weight(.medium)).lineLimit(1)
                    if let handle = user?.handle {
                        Text(handle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                UserStatusBadge(userId: userId, font: .footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Server calls shared by the people list and the profile.
@MainActor
enum UserActions {
    /// `POST /chats/direct` (idempotent: the existing chat if there is one),
    /// then opens the conversation.
    static func message(_ userId: Int, env: AppEnvironment) async throws {
        let chat = try await env.api.call {
            try await $0.chats_createDirectChat(body: .json(.init(userId: userId)))
        }.ok.body.json
        env.router.push(.chat(chat.id, messageId: nil))
    }

    /// Admin only — the server answers 403 for anyone else.
    static func setRole(_ role: Components.Schemas.UserRole, for userId: Int, env: AppEnvironment) async throws {
        let updated = try await env.api.call {
            try await $0.users_updateUserRole(path: .init(id: String(userId)), body: .json(.init(role: role)))
        }.ok.body.json
        env.users.store(updated)
    }

    /// Admin only: permanently deletes another account.
    static func delete(_ userId: Int, env: AppEnvironment) async throws {
        _ = try await env.api.call { try await $0.users_deleteUser(path: .init(id: String(userId))) }
        env.users.forget(userId)
        env.invalidations.invalidate(.posts, .users)
    }
}
