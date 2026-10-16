import SwiftUI

/// A post with its threaded comments and a composer pinned to the bottom.
struct PostDetailView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let postId: Int

    @State private var model: CommentsModel?
    @State private var loadFailure: String?
    @State private var missing = false
    @State private var draft = ""
    @State private var replyTarget: Int?
    @State private var editingComment: Int?
    @State private var sending = false
    @State private var errorMessage: String?
    @State private var room: RoomToken?
    @State private var editingPost: Post?
    @FocusState private var composerFocused: Bool

    var body: some View {
        Group {
            if missing {
                EmptyState(title: "Post not found", systemImage: "questionmark.folder", message: "It may have been deleted.", identifier: "post.missing")
            } else if let post = env.posts.post(postId), let model {
                content(post: post, model: model)
            } else if let loadFailure {
                EmptyState(title: "Couldn't load post", systemImage: "wifi.exclamationmark", message: loadFailure, identifier: "post.error",
                           action: (title: "Try again", run: { Task { await load() } }))
            } else {
                ProgressView().accessibilityIdentifier("post.loading")
            }
        }
        .navigationTitle("Post")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil { model = CommentsModel(postId: postId, api: env.api, users: env.users) }
            room = env.realtime.joinPostRoom(postId)
            await load()
        }
        .onDisappear { room?.cancel(); room = nil }
        .task(id: env.invalidations.token(.posts)) { if model != nil { await load() } }
        .task(id: env.invalidations.token(.comments)) { await model?.reload() }
        .sheet(item: $editingPost) { PostComposerView(editing: $0) }
        .alert("Something went wrong", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK") {}
        } message: { Text(errorMessage ?? "") }
    }

    private func load() async {
        do {
            _ = try await env.posts.fetch(postId)
            loadFailure = nil
            await model?.reload()
        } catch let error as APIError where error.isNotFound {
            missing = true
        } catch {
            if env.posts.post(postId) == nil { loadFailure = APIError.from(error).message }
        }
    }

    @ViewBuilder
    private func content(post: Post, model: CommentsModel) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    PostRow(postId: post.id) { editingPost = $0 }
                        .padding(.horizontal)
                    Divider().padding(.vertical, 8)
                    Text("Comments").font(.headline).padding(.horizontal)
                        .accessibilityAddTraits(.isHeader)
                    switch model.phase {
                    case .idle, .loading:
                        VStack { SkeletonRows(count: 2) }.padding(.horizontal)
                    case .failed(let message):
                        ErrorBanner(message: message, retry: { Task { await model.reload(reset: true) } }, identifier: "comments.error").padding()
                    case .loaded:
                        if model.top.ids.isEmpty {
                            Text("No comments yet.").foregroundStyle(.secondary).padding()
                                .accessibilityIdentifier("comments.empty")
                        }
                        CommentList(model: model, parent: nil, depth: 0, onReply: startReply, onEdit: startEdit, onError: { errorMessage = $0 })
                    }
                }
            }
            .refreshable { await load(); await model.reload(reset: true) }
            Divider()
            composer(model: model)
        }
    }

    private func composer(model: CommentsModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let target = replyTarget ?? editingComment {
                HStack {
                    Text(editingComment != nil ? "Editing comment" : "Replying to \(env.users.user(model.comments[target]?.authorId ?? 0)?.shownName ?? "comment")")
                        .font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel") { replyTarget = nil; editingComment = nil; draft = "" }
                        .font(.footnote).accessibilityIdentifier("comment.composer.cancel")
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Add a comment…", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .padding(10)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                    .accessibilityIdentifier("comment.composer.field")
                Button {
                    Task { await send(model: model) }
                } label: {
                    if sending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)) }
                }
                .disabled(trimmedDraft.isEmpty || sending || trimmedDraft.count > 2000)
                .accessibilityLabel(editingComment != nil ? "Save comment" : "Send comment")
                .accessibilityIdentifier("comment.composer.send")
            }
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }

    private var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func startReply(_ id: Int) { editingComment = nil; replyTarget = id; composerFocused = true }
    private func startEdit(_ id: Int, _ text: String) { replyTarget = nil; editingComment = id; draft = text; composerFocused = true }

    private func send(model: CommentsModel) async {
        sending = true
        defer { sending = false }
        do {
            if let editingComment { try await model.edit(editingComment, to: trimmedDraft) }
            else { try await model.add(trimmedDraft, replyingTo: replyTarget) }
            draft = ""; replyTarget = nil; editingComment = nil
            composerFocused = false
            _ = try? await env.posts.fetch(postId) // refresh the comment count
        } catch {
            errorMessage = APIError.from(error).message
        }
    }
}

/// Comments under `parent` (nil = the post), each followed by its expanded
/// replies, indented up to a few levels.
struct CommentList: View {
    @Environment(AppEnvironment.self) private var env
    let model: CommentsModel
    let parent: Int?
    let depth: Int
    let onReply: (Int) -> Void
    let onEdit: (Int, String) -> Void
    let onError: (String) -> Void

    var body: some View {
        ForEach(model.children(of: parent), id: \.self) { id in
            if let comment = model.comments[id] {
                CommentRow(model: model, comment: comment, depth: depth, onReply: onReply, onEdit: onEdit, onError: onError)
                if model.expanded.contains(id) {
                    CommentList(model: model, parent: id, depth: depth + 1, onReply: onReply, onEdit: onEdit, onError: onError)
                }
            }
        }
        if model.hasMoreChildren(of: parent) {
            Button("Load more") { Task { await model.loadMore(parent: parent) } }
                .font(.subheadline).padding(.leading, CGFloat(min(depth, 3)) * 24 + 16).padding(.vertical, 6)
                .accessibilityIdentifier("comments.more.\(parent.map(String.init) ?? "top")")
                .onAppear { Task { await model.loadMore(parent: parent) } }
        }
    }
}

struct CommentRow: View {
    @Environment(AppEnvironment.self) private var env
    let model: CommentsModel
    let comment: Comment
    let depth: Int
    let onReply: (Int) -> Void
    let onEdit: (Int, String) -> Void
    let onError: (String) -> Void
    @State private var confirmingDelete = false

    var body: some View {
        let author = env.users.user(comment.authorId)
        let isMine = comment.authorId == env.auth.user?.id
        HStack(alignment: .top, spacing: 10) {
            Button { env.router.push(.profile(comment.authorId)) } label: {
                AvatarView(userId: comment.authorId, size: 30)
            }
            .buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(author?.shownName ?? "…").font(.subheadline.weight(.semibold))
                    Text(TimeText.relative(comment.createdAt) + (comment.updatedAt > comment.createdAt + 1000 ? " · edited" : ""))
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if isMine || env.auth.user?.role == .admin {
                        Menu {
                            if isMine { Button("Edit", systemImage: "pencil") { onEdit(comment.id, comment.content) }.accessibilityIdentifier("comment.\(comment.id).edit") }
                            Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = true }.accessibilityIdentifier("comment.\(comment.id).delete")
                        } label: { Image(systemName: "ellipsis").padding(6) }
                            .accessibilityLabel("Comment options")
                            .accessibilityIdentifier("comment.\(comment.id).menu")
                    }
                }
                MentionText(text: comment.content, identifier: "comment.\(comment.id).text")
                ReactionBar(reactions: comment.reactions, identifier: "comment.\(comment.id)") { emoji in
                    Task { do { try await model.toggleReaction(emoji, on: comment.id) } catch { onError(APIError.from(error).message) } }
                }
                HStack(spacing: 16) {
                    Button("Reply") { onReply(comment.id) }.accessibilityIdentifier("comment.\(comment.id).reply")
                    if comment.replyCount > 0 {
                        Button {
                            Task { await model.toggleReplies(of: comment.id) }
                        } label: {
                            Label(model.expanded.contains(comment.id) ? "Hide replies" : "\(comment.replyCount) \(comment.replyCount == 1 ? "reply" : "replies")",
                                  systemImage: model.expanded.contains(comment.id) ? "chevron.up" : "chevron.down")
                        }
                        .accessibilityIdentifier("comment.\(comment.id).replies")
                    }
                }
                .font(.footnote.weight(.medium))
            }
        }
        .padding(.leading, CGFloat(min(depth, 3)) * 24 + 16).padding(.trailing, 16).padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("comment.\(comment.id)")
        .task(id: comment.authorId) { await env.users.ensure([comment.authorId]) }
        .confirmationDialog("Delete this comment?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task { do { try await model.delete(comment.id) } catch { onError(APIError.from(error).message) } }
            }
            .accessibilityIdentifier("comment.\(comment.id).delete.confirm")
        }
    }
}
