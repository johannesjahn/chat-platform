import SwiftUI

/// A person's profile with their posts. (Phase 3 grows this with the user
/// list, settings, blocking, status and avatar editing.)
struct ProfileView: View {
    @Environment(AppEnvironment.self) private var env
    let userId: Int
    @State private var list = PostStore.PostList()
    @State private var profile: UserProfile?
    @State private var failure: String?

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    AvatarView(userId: userId, size: 64, showsPresence: true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(profile?.displayName ?? profile?.username ?? "…").font(.title3.bold())
                            .accessibilityIdentifier("profile.name")
                        if let profile { Text("@\(profile.username)").foregroundStyle(.secondary).accessibilityIdentifier("profile.username") }
                        if let bio = profile?.bio, !bio.isEmpty { Text(bio).font(.subheadline).padding(.top, 2) }
                    }
                }
                .padding(.vertical, 4)
                if let failure { ErrorBanner(message: failure, retry: { Task { await loadProfile() } }, identifier: "profile.error") }
            }
            Section("Posts") {
                switch list.phase {
                case .idle, .loading: SkeletonRows(count: 2)
                case .failed(let message): ErrorBanner(message: message, retry: { Task { await reload(reset: true) } }, identifier: "profile.posts.error")
                case .loaded:
                    if list.page.ids.isEmpty { Text("No posts yet.").foregroundStyle(.secondary).accessibilityIdentifier("profile.posts.empty") }
                    ForEach(list.page.ids, id: \.self) { id in
                        PostRow(postId: id)
                            .onAppear { if id == list.page.ids.last { Task { await env.posts.loadMore(list, source: .user(userId)) } } }
                    }
                }
            }
        }
        .navigationTitle(profile?.username ?? "Profile")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("profile.screen")
        .refreshable { await loadProfile(); await reload(reset: true) }
        .task(id: env.invalidations.token(.posts)) { await reload(reset: false) }
        .task { await loadProfile() }
    }

    private func reload(reset: Bool) async { await env.posts.load(list, source: .user(userId), reset: reset) }

    private func loadProfile() async {
        do {
            let loaded = try await env.api.call { try await $0.users_getUser(path: .init(id: String(userId))) }.ok.body.json
            env.users.store(loaded)
            profile = loaded
            failure = nil
        } catch {
            failure = APIError.from(error).message
        }
    }
}
