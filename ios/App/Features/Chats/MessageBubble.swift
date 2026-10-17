import AVKit
import ChatAPI
import SwiftUI

/// What a bubble may offer, decided by the conversation (who's asking,
/// what their role is).
struct MessageActions {
    var reply: () -> Void
    var react: (ReactionEmoji) -> Void
    var edit: (() -> Void)?
    var delete: (() -> Void)?
    var togglePin: () -> Void
    var toggleStar: () -> Void
    var forward: () -> Void
    var jumpToParent: (Int) -> Void
}

/// One message: sender (in groups), a reply preview, the content, reactions,
/// and a footer with time, edited/pinned/starred marks and — on your own —
/// whether it's been read. Long-press for everything else.
struct MessageBubble: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let message: Message
    let isOwn: Bool
    let senderName: String
    /// Show the name above (first of a run in a group, from someone else).
    let showsSender: Bool
    let highlighted: Bool
    let actions: MessageActions

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if isOwn { Spacer(minLength: 48) }
            VStack(alignment: isOwn ? .trailing : .leading, spacing: 4) {
                if showsSender {
                    Text(senderName).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                }
                bubble
                if !message.reactions.filter({ $0.count > 0 }).isEmpty { reactions }
            }
            if !isOwn { Spacer(minLength: 48) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 2)
        .background(highlighted ? Color.accentColor.opacity(0.22) : .clear)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.35), value: highlighted)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message.\(message.id)")
        .accessibilityAction(named: "Reply", actions.reply)
        .accessibilityAction(named: message.pinned ? "Unpin" : "Pin", actions.togglePin)
        .accessibilityAction(named: message.starred ? "Unstar" : "Star", actions.toggleStar)
        .accessibilityAction(named: "Forward", actions.forward)
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let forwarded = message.forwardedFrom {
                Label("Forwarded from \(forwarded.senderName)", systemImage: "arrowshape.turn.up.right")
                    .font(.caption.italic())
                    .foregroundStyle(isOwn ? Color("OnAccent").opacity(0.8) : .secondary)
                    .accessibilityIdentifier("message.\(message.id).forwarded")
            }
            if let parent = message.parentMessage {
                Button { actions.jumpToParent(parent.id) } label: {
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 1.5).fill(isOwn ? Color("OnAccent") : Color.accentColor).frame(width: 3)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(parent.senderName).font(.caption.weight(.semibold))
                            Text(parentPreview(parent)).font(.caption).lineLimit(2)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background((isOwn ? Color.black : Color.primary).opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Reply to \(parent.senderName): \(parentPreview(parent))")
                .accessibilityHint("Shows the original message")
                .accessibilityIdentifier("message.\(message.id).parent")
            }
            content
            footer
        }
        .foregroundStyle(isOwn ? Color("OnAccent") : Color.primary)
        .tint(isOwn ? Color("OnAccent") : Color.accentColor)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(isOwn ? Color.accentColor : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 18))
        .contextMenu { menu }
    }

    @ViewBuilder private var content: some View {
        switch message.contentType {
        case .text:
            MentionText(text: message.content, identifier: "message.\(message.id).text")
        case .imageUrl:
            RemoteImage(urlString: message.content, contentMode: .fit)
                .frame(maxWidth: 240, maxHeight: 280)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("Photo")
                .accessibilityIdentifier("message.\(message.id).attachment")
        case .attachment:
            if let attachment = message.attachment {
                ChatAttachmentView(attachment: attachment, isOwn: isOwn, identifier: "message.\(message.id).attachment")
            }
            if let attachment = message.attachment, message.content != attachment.filename, !message.content.isEmpty {
                MentionText(text: message.content, identifier: "message.\(message.id).text")
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 4) {
            if message.pinned { Image(systemName: "pin.fill").accessibilityLabel("Pinned").accessibilityIdentifier("message.\(message.id).pinned") }
            if message.starred { Image(systemName: "star.fill").accessibilityLabel("Starred").accessibilityIdentifier("message.\(message.id).starred") }
            if message.isEdited { Text("edited").accessibilityIdentifier("message.\(message.id).edited") }
            Text(ChatTime.bubbleTime(message.createdAt))
            if isOwn {
                let read = !message.readByUserIds.isEmpty
                Image(systemName: read ? "checkmark.circle.fill" : "checkmark")
                    .accessibilityLabel(read ? "Read" : "Sent")
                    .accessibilityIdentifier("message.\(message.id).read")
            }
        }
        .font(.caption2)
        .opacity(0.75)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var reactions: some View {
        HStack(spacing: 6) {
            ForEach(message.reactions.filter { $0.count > 0 }, id: \.emoji) { reaction in
                Button {
                    if let emoji = ReactionEmoji(rawValue: reaction.emoji) { actions.react(emoji) }
                } label: {
                    HStack(spacing: 3) {
                        Text(reaction.emoji)
                        Text("\(reaction.count)").font(.caption.weight(.medium)).monospacedDigit()
                    }
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(reaction.reactedByMe ? Color.accentColor.opacity(0.2) : Color(.tertiarySystemFill), in: Capsule())
                    .overlay(Capsule().stroke(reaction.reactedByMe ? Color.accentColor : .clear, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(reaction.emoji) \(reaction.count)\(reaction.reactedByMe ? ", you reacted" : "")")
                .accessibilityIdentifier("message.\(message.id).reaction.\(reaction.emoji)")
            }
        }
    }

    @ViewBuilder private var menu: some View {
        Button("Reply", systemImage: "arrowshape.turn.up.left", action: actions.reply)
            .accessibilityIdentifier("message.action.reply")
        Menu("React", systemImage: "face.smiling") {
            ForEach(ReactionEmoji.picker, id: \.rawValue) { emoji in
                Button(emoji.rawValue) { actions.react(emoji) }
                    .accessibilityIdentifier("message.action.react.\(emoji.rawValue)")
            }
        }
        .accessibilityIdentifier("message.action.react")
        if message.contentType == .text {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.content }
                .accessibilityIdentifier("message.action.copy")
        }
        if let edit = actions.edit {
            Button("Edit", systemImage: "pencil", action: edit).accessibilityIdentifier("message.action.edit")
        }
        Button(message.pinned ? "Unpin" : "Pin", systemImage: message.pinned ? "pin.slash" : "pin", action: actions.togglePin)
            .accessibilityIdentifier("message.action.pin")
        Button(message.starred ? "Unstar" : "Star", systemImage: message.starred ? "star.slash" : "star", action: actions.toggleStar)
            .accessibilityIdentifier("message.action.star")
        Button("Forward", systemImage: "arrowshape.turn.up.right", action: actions.forward)
            .accessibilityIdentifier("message.action.forward")
        if let delete = actions.delete {
            Button("Delete", systemImage: "trash", role: .destructive, action: delete)
                .accessibilityIdentifier("message.action.delete")
        }
    }

    private func parentPreview(_ parent: Components.Schemas.ParentMessagePreview) -> String {
        switch parent.contentType {
        case .imageUrl: return "📷 Photo"
        case .attachment: return "📎 \(parent.content)"
        case .text: return parent.content
        }
    }
}

/// A message that hasn't reached the server yet: dimmed while sending, red
/// with Retry/Discard if it failed.
struct PendingBubble: View {
    let pending: PendingMessage
    let retry: () -> Void
    let discard: () -> Void

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 4) {
                VStack(alignment: .leading, spacing: 6) {
                    if let parent = pending.parentPreview {
                        Text(parent).font(.caption).lineLimit(1).opacity(0.8)
                    }
                    if pending.contentType == .attachment {
                        Label(pending.content, systemImage: "paperclip")
                    } else {
                        Text(pending.content)
                    }
                    HStack(spacing: 4) {
                        if case .failed = pending.state { Image(systemName: "exclamationmark.circle.fill") }
                        else { Image(systemName: "clock") }
                    }
                    .font(.caption2).frame(maxWidth: .infinity, alignment: .trailing)
                }
                .foregroundStyle(Color("OnAccent"))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.accentColor.opacity(isFailed ? 0.45 : 0.7), in: RoundedRectangle(cornerRadius: 18))
                if case .failed(let reason) = pending.state {
                    Text(reason).font(.caption).foregroundStyle(.red).multilineTextAlignment(.trailing)
                        .accessibilityIdentifier("pending.\(pending.clientId).error")
                    HStack(spacing: 16) {
                        Button("Discard", role: .destructive, action: discard).accessibilityIdentifier("pending.discard")
                        Button("Retry", action: retry).fontWeight(.semibold).accessibilityIdentifier("pending.retry")
                    }
                    .font(.caption)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(isFailed ? "Not sent: \(pending.content)" : "Sending: \(pending.content)")
        .accessibilityIdentifier("pending.\(pending.clientId)")
    }

    private var isFailed: Bool { if case .failed = pending.state { true } else { false } }
}

/// An attachment in a bubble: images inline, video in a player, audio with
/// a play button, anything else as a file chip that opens it.
struct ChatAttachmentView: View {
    @Environment(AppEnvironment.self) private var env
    let attachment: Attachment
    let isOwn: Bool
    let identifier: String

    var body: some View {
        let url = env.images.resolve(attachment.url)
        if attachment.mimeType.hasPrefix("image/") {
            let ratio = (attachment.width ?? 0) > 0 && (attachment.height ?? 0) > 0
                ? CGFloat(attachment.width!) / CGFloat(attachment.height!) : 4.0 / 3.0
            RemoteImage(urlString: attachment.url, contentMode: .fit)
                .aspectRatio(ratio, contentMode: .fit)
                .frame(maxWidth: 240, maxHeight: 300)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityElement()
                .accessibilityLabel("Photo: \(attachment.filename)")
                .accessibilityIdentifier(identifier)
        } else if attachment.mimeType.hasPrefix("video/"), let url {
            VideoPlayer(player: AVPlayer(url: url))
                .frame(width: 240, height: 160)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("Video: \(attachment.filename)")
                .accessibilityIdentifier(identifier)
        } else if attachment.mimeType.hasPrefix("audio/"), let url {
            AudioAttachmentPlayer(url: url, durationMs: attachment.durationMs.map { Int($0) }, identifier: identifier)
        } else {
            Link(destination: url ?? URL(string: "about:blank")!) {
                HStack(spacing: 8) {
                    Image(systemName: "doc.fill").font(.title3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(attachment.filename).font(.subheadline.weight(.medium)).lineLimit(2)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file)).font(.caption).opacity(0.75)
                    }
                }
                .padding(10)
                .background((isOwn ? Color.black : Color.primary).opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            }
            .accessibilityLabel("File: \(attachment.filename)")
            .accessibilityIdentifier(identifier)
        }
    }
}

/// Play/pause for a voice message or audio file.
struct AudioAttachmentPlayer: View {
    let url: URL
    let durationMs: Int?
    let identifier: String
    @State private var player: AVPlayer?
    @State private var playing = false

    var body: some View {
        Button {
            if player == nil { player = AVPlayer(url: url) }
            if playing { player?.pause() } else { player?.seek(to: .zero); player?.play() }
            playing.toggle()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: playing ? "pause.circle.fill" : "play.circle.fill").font(.title)
                Image(systemName: "waveform")
                if let durationMs { Text(Duration.milliseconds(durationMs).formatted(.time(pattern: .minuteSecond))).monospacedDigit().font(.caption) }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(playing ? "Pause voice message" : "Play voice message")
        .accessibilityIdentifier(identifier)
        .onDisappear { player?.pause(); playing = false }
    }
}
