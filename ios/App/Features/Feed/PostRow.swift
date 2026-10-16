import ChatAPI
import SwiftUI

/// One post as it appears in a list: author, text, attachment, reactions and
/// a comments count. The body links to the post; the controls act in place.
struct PostRow: View {
    @Environment(AppEnvironment.self) private var env
    let postId: Int
    var onEdit: ((Post) -> Void)?
    @State private var confirmingDelete = false
    @State private var errorMessage: String?

    var body: some View {
        if let post = env.posts.post(postId) {
            VStack(alignment: .leading, spacing: 10) {
                header(post)
                // Not a NavigationLink: inside a List it grows a disclosure
                // chevron, and the post's own links (mentions) must stay tappable.
                PostBody(post: post)
                    .contentShape(Rectangle())
                    .onTapGesture { env.router.push(.post(post.id)) }
                    .accessibilityElement(children: .contain)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("feed.post.\(post.id)")
                ReactionBar(reactions: post.reactions, identifier: "post.\(post.id)") { emoji in
                    Task {
                        do { try await env.posts.toggleReaction(emoji, on: post.id) }
                        catch { errorMessage = APIError.from(error).message }
                    }
                }
                Button { env.router.push(.post(post.id)) } label: {
                    Label(post.commentCount == 1 ? "1 comment" : "\(post.commentCount) comments", systemImage: "bubble.left")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("post.\(post.id).comments")
            }
            .padding(.vertical, 6)
            .alert("Couldn't update", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK") {}
            } message: { Text(errorMessage ?? "") }
            .confirmationDialog("Delete this post?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task {
                        do { try await env.posts.delete(post.id) }
                        catch { errorMessage = APIError.from(error).message }
                    }
                }
                .accessibilityIdentifier("post.\(post.id).delete.confirm")
            }
            .task(id: post.authorId) { await env.users.ensure([post.authorId]) }
        }
    }

    private func header(_ post: Post) -> some View {
        let author = env.users.user(post.authorId)
        return HStack(spacing: 10) {
            Button { env.router.push(.profile(post.authorId)) } label: {
                HStack(spacing: 10) {
                    AvatarView(userId: post.authorId, size: 38, showsPresence: true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(author?.shownName ?? "…").font(.subheadline.weight(.semibold))
                        Text(TimeText.relative(post.createdAt) + (post.updatedAt > post.createdAt + 1000 ? " · edited" : ""))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("post.\(post.id).author")
            Spacer()
            if post.authorId == env.auth.user?.id || env.auth.user?.role == .admin {
                Menu {
                    if post.authorId == env.auth.user?.id, post.contentType != .attachment, let onEdit {
                        Button("Edit", systemImage: "pencil") { onEdit(post) }
                            .accessibilityIdentifier("post.\(post.id).edit")
                    }
                    Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = true }
                        .accessibilityIdentifier("post.\(post.id).delete")
                } label: {
                    Image(systemName: "ellipsis").padding(8).contentShape(Rectangle())
                }
                .accessibilityLabel("Post options")
                .accessibilityIdentifier("post.\(post.id).menu")
            }
        }
    }
}

/// A post's content: its text and any attachment.
struct PostBody: View {
    @Environment(AppEnvironment.self) private var env
    let post: Post

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch post.contentType {
            case .text:
                MentionText(text: post.content, identifier: "post.\(post.id).text")
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .imageUrl:
                RemoteImage(urlString: post.content, contentMode: .fit)
                    .frame(maxHeight: 360).clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Image")
            case .attachment:
                if let attachment = post.attachment {
                    AttachmentView(attachment: attachment, identifier: "post.\(post.id).attachment")
                }
            }
        }
        .contentShape(Rectangle())
    }
}

/// An uploaded file: images inline, anything else as a file chip.
struct AttachmentView: View {
    let attachment: Attachment
    var identifier: String

    var body: some View {
        if attachment.mimeType.hasPrefix("image/") {
            let ratio = (attachment.width ?? 0) > 0 && (attachment.height ?? 0) > 0
                ? CGFloat(attachment.width!) / CGFloat(attachment.height!) : 4.0 / 3.0
            RemoteImage(urlString: attachment.url, contentMode: .fit)
                .aspectRatio(ratio, contentMode: .fit)
                .frame(maxHeight: 420)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("Image: \(attachment.filename)")
                .accessibilityIdentifier(identifier)
        } else {
            Link(destination: URL(string: attachment.url) ?? URL(string: "about:blank")!) {
                Label(attachment.filename, systemImage: attachment.mimeType.hasPrefix("video/") ? "play.rectangle" : attachment.mimeType.hasPrefix("audio/") ? "waveform" : "doc")
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
            }
            .accessibilityIdentifier(identifier)
        }
    }
}
