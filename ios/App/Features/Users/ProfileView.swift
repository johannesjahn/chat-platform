import ChatAPI
import SwiftUI

/// A person's profile: who they are, their status and posts, and what you
/// can do about them (message, mute/block; admins: role, delete). `Route.profile`.
struct ProfileView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let userId: Int
    @State private var list = PostStore.PostList()
    @State private var profile: UserProfile?
    @State private var failure: String?
    @State private var notFound = false
    @State private var busy = false
    @State private var actionError: String?
    @State private var confirmingBlock = false
    @State private var confirmingDelete = false

    private var me: User? { env.auth.user }
    private var isSelf: Bool { me?.id == userId }
    private var viewerIsAdmin: Bool { me?.role == .admin }

    var body: some View {
        List {
            if notFound {
                EmptyState(title: "User not found", systemImage: "person.slash",
                           message: "This account may have been deleted.", identifier: "profile.notFound")
            } else {
                header
                if let actionError {
                    ErrorBanner(message: actionError, identifier: "profile.actionError")
                }
                if !isSelf, profile != nil { privacySection }
                if viewerIsAdmin, !isSelf, profile != nil { adminSection }
                postsSection
            }
        }
        .navigationTitle(profile.map { "@\($0.username)" } ?? "Profile")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("profile.screen")
        .refreshable {
            await loadProfile()
            await reload(reset: true)
        }
        .task(id: env.invalidations.token(.posts)) { await reload(reset: false) }
        .task(id: env.invalidations.token(.users)) { await loadProfile() }
        .task { if let me, !isSelf { await env.blocks.load(for: me.id) } }
        .confirmationDialog("Block \(profile?.label ?? "this user")?", isPresented: $confirmingBlock, titleVisibility: .visible) {
            Button("Block", role: .destructive) { apply { try await env.blocks.set(.block, for: userId) } }
                .accessibilityIdentifier("profile.block.confirm")
        } message: {
            Text("You won't see their posts or get their notifications, and neither of you can message the other.")
        }
        .confirmationDialog("Permanently delete \(profile?.label ?? "this user")?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete user", role: .destructive) {
                apply {
                    try await UserActions.delete(userId, env: env)
                    dismiss()
                }
            }
            .accessibilityIdentifier("profile.delete.confirm")
        } message: {
            Text("This removes their account, posts, comments, and messages, and can't be undone.")
        }
    }

    // MARK: sections

    private var header: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center, spacing: 16) {
                    AvatarView(userId: userId, size: 76, showsPresence: true, identifier: "profile.avatar")
                    VStack(alignment: .leading, spacing: 3) {
                        let named = profile?.displayName?.isEmpty == false
                        Text(profile?.label ?? "…").font(.title2.bold())
                            .accessibilityIdentifier(named || profile == nil ? "profile.name" : "profile.username")
                        // Without a display name the title already is the handle.
                        if let profile, profile.displayName?.isEmpty == false {
                            Text("@\(profile.username)").foregroundStyle(.secondary)
                                .accessibilityIdentifier("profile.username")
                        }
                        HStack(spacing: 8) {
                            if profile?.role == .admin {
                                Label("Admin", systemImage: "checkmark.shield")
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(Color.accentColor.opacity(0.18), in: Capsule())
                                    .accessibilityIdentifier("profile.role")
                            }
                            if env.users.isOnline(userId) {
                                Text("Online").font(.caption).foregroundStyle(.secondary)
                                    .accessibilityIdentifier("profile.online")
                            }
                            if let total = list.totalCount {
                                Text(total == 1 ? "1 post" : "\(total) posts").font(.caption).foregroundStyle(.secondary)
                                    .accessibilityIdentifier("profile.postCount")
                            }
                        }
                    }
                }
                UserStatusBadge(userId: userId, font: .body, showsExpiry: true, identifier: "profile.status")
                if let bio = profile?.bio, !bio.isEmpty {
                    Text(bio).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("profile.bio")
                }
                if let failure {
                    ErrorBanner(message: failure, retry: { Task { await loadProfile() } }, identifier: "profile.error")
                }
                if profile != nil { primaryAction }
            }
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private var primaryAction: some View {
        if isSelf {
            NavigationLink(value: Route.settings) {
                Label("Edit profile", systemImage: "pencil")
            }
            .accessibilityIdentifier("profile.edit")
        } else {
            Button {
                apply { try await UserActions.message(userId, env: env) }
            } label: {
                Label("Message", systemImage: "message").frame(maxWidth: .infinity)
            }
            .buttonStyle(.primary)
            .disabled(busy)
            .accessibilityIdentifier("profile.message")
        }
    }

    @ViewBuilder
    private var privacySection: some View {
        let current = env.blocks.type(of: userId)
        Section {
            switch current {
            case .block:
                Button("Unblock", systemImage: "hand.raised.slash") {
                    apply { try await env.blocks.remove(userId) }
                }
                .accessibilityIdentifier("profile.unblock")
            case .mute:
                Button("Unmute", systemImage: "bell") { apply { try await env.blocks.remove(userId) } }
                    .accessibilityIdentifier("profile.unmute")
                Button("Block", systemImage: "hand.raised", role: .destructive) { confirmingBlock = true }
                    .accessibilityIdentifier("profile.block")
            case nil:
                Button("Mute", systemImage: "bell.slash") { apply { try await env.blocks.set(.mute, for: userId) } }
                    .accessibilityIdentifier("profile.mute")
                Button("Block", systemImage: "hand.raised", role: .destructive) { confirmingBlock = true }
                    .accessibilityIdentifier("profile.block")
            }
        } header: {
            Text("Privacy")
        } footer: {
            switch current {
            case .block: Text("Blocked: you don't see their posts, and neither of you can message the other.")
            case .mute: Text("Muted: their posts and notifications are hidden from you.")
            case nil: Text("Muting hides their posts and notifications. Blocking also stops direct messages both ways.")
            }
        }
        .disabled(busy)
    }

    private var adminSection: some View {
        Section("Admin") {
            let isAdmin = profile?.role == .admin
            Button(isAdmin ? "Revoke admin" : "Make admin", systemImage: isAdmin ? "shield.slash" : "checkmark.shield") {
                apply {
                    try await UserActions.setRole(isAdmin ? .user : .admin, for: userId, env: env)
                    await loadProfile()
                }
            }
            .accessibilityIdentifier("profile.toggleRole")
            Button("Delete user", systemImage: "trash", role: .destructive) { confirmingDelete = true }
                .accessibilityIdentifier("profile.delete")
        }
        .disabled(busy)
    }

    private var postsSection: some View {
        Section(isSelf ? "Your posts" : "Recent posts") {
            switch list.phase {
            case .idle, .loading: SkeletonRows(count: 2)
            case .failed(let message): ErrorBanner(message: message, retry: { Task { await reload(reset: true) } }, identifier: "profile.posts.error")
            case .loaded:
                if list.page.ids.isEmpty {
                    Text(isSelf ? "Anything you post will show up here." : "No posts yet.")
                        .foregroundStyle(.secondary).accessibilityIdentifier("profile.posts.empty")
                }
                ForEach(list.page.ids, id: \.self) { id in
                    PostRow(postId: id)
                        .onAppear { if id == list.page.ids.last { Task { await env.posts.loadMore(list, source: .user(userId)) } } }
                }
                if list.isLoadingMore { ProgressView().frame(maxWidth: .infinity) }
                if let error = list.loadMoreError {
                    ErrorBanner(message: error, retry: { Task { await env.posts.loadMore(list, source: .user(userId)) } }, identifier: "profile.posts.moreError")
                }
            }
        }
    }

    // MARK: loading

    private func apply(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        actionError = nil
        Task {
            defer { busy = false }
            do { try await action() } catch { actionError = APIError.from(error).message }
        }
    }

    private func reload(reset: Bool) async {
        guard !notFound else { return }
        await env.posts.load(list, source: .user(userId), reset: reset)
    }

    private func loadProfile() async {
        do {
            let loaded = try await env.api.call { try await $0.users_getUser(path: .init(id: String(userId))) }.ok.body.json
            env.users.store(loaded)
            profile = loaded
            failure = nil
        } catch let error as APIError where error.isNotFound {
            notFound = true
        } catch {
            let error = APIError.from(error)
            if !error.isCancelled { failure = error.message }
        }
    }
}
