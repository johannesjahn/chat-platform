import SwiftUI

struct FeedView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var composing = false
    @State private var editing: Post?

    var body: some View {
        let feed = env.posts.feed
        List {
            switch feed.phase {
            case .idle, .loading:
                SkeletonRows()
            case .failed(let message):
                ErrorBanner(message: message, retry: { Task { await reload(reset: true) } }, identifier: "feed.error")
                    .listRowSeparator(.hidden)
            case .loaded:
                ForEach(feed.page.ids, id: \.self) { id in
                    PostRow(postId: id) { editing = $0 }
                        .onAppear {
                            if id == feed.page.ids.last { Task { await env.posts.loadMore(feed, source: .feed) } }
                        }
                }
                if feed.isLoadingMore {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                        .accessibilityIdentifier("feed.loadingMore")
                }
                if let error = feed.loadMoreError {
                    ErrorBanner(message: error, retry: { Task { await env.posts.loadMore(feed, source: .feed) } }, identifier: "feed.moreError")
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if feed.phase == .loaded, feed.page.ids.isEmpty {
                EmptyState(title: "No posts yet", systemImage: "text.bubble", message: "Be the first to share something.",
                           identifier: "feed.empty", action: (title: "New post", run: { composing = true }))
            }
        }
        .accessibilityIdentifier("feed.list")
        .navigationTitle("Feed")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { env.router.push(.search) } label: { Image(systemName: "magnifyingglass") }
                    .accessibilityLabel("Search")
                    .accessibilityIdentifier("feed.search")
            }
            ToolbarItem(placement: .primaryAction) {
                Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New post")
                    .accessibilityIdentifier("feed.compose")
            }
        }
        .refreshable { await reload(reset: true) }
        .task(id: env.invalidations.token(.posts)) { await reload(reset: false) }
        .sheet(isPresented: $composing) { PostComposerView(editing: nil) }
        .sheet(item: $editing) { PostComposerView(editing: $0) }
    }

    private func reload(reset: Bool) async {
        await env.posts.load(env.posts.feed, source: .feed, reset: reset)
    }
}

extension Post: @retroactive Identifiable {}
