import ChatAPI
import SwiftUI

/// The newest pinned message under the header; tap to jump to it, or open
/// the whole list.
struct PinnedBar: View {
    @Environment(AppEnvironment.self) private var env
    let chatId: Int
    let onOpen: (Int) -> Void
    let onList: () -> Void

    var body: some View {
        let pins = env.messages.window(chatId).pins
        if let latest = pins.first {
            HStack(spacing: 10) {
                Button { onOpen(latest.id) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "pin.fill").foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(pins.count == 1 ? "Pinned message" : "Pinned message · \(pins.count)").font(.caption.weight(.semibold))
                            Text(latest.preview).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Shows the pinned message")
                .accessibilityIdentifier("chat.pinnedBar")
                Button(action: onList) { Image(systemName: "list.bullet") }
                    .accessibilityLabel("All pinned messages")
                    .accessibilityIdentifier("chat.pinnedBar.list")
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }
        }
    }
}

/// The pinned or starred list as a sheet of its own.
struct PinnedMessagesSheet: View {
    @Environment(\.dismiss) private var dismiss
    let chatId: Int
    let starred: Bool
    let onSelect: (Int) -> Void

    var body: some View {
        NavigationStack {
            PinnedMessagesList(chatId: chatId, starred: starred, onSelect: onSelect)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("pins.done") } }
        }
    }
}

/// The chat's pinned messages (everyone's) or your starred ones (private).
struct PinnedMessagesList: View {
    @Environment(AppEnvironment.self) private var env
    let chatId: Int
    let starred: Bool
    let onSelect: (Int) -> Void

    @State private var phase: LoadPhase = .idle

    var body: some View {
        let window = env.messages.window(chatId)
        let messages = starred ? window.stars : window.pins
        let chat = env.chats.chat(chatId)
        Group {
            List {
                if messages.isEmpty, phase == .idle || phase == .loading {
                    SkeletonRows(count: 2)
                } else if messages.isEmpty, case .failed(let message) = phase {
                    ErrorBanner(message: message, retry: { Task { await load() } }, identifier: "pins.error")
                } else {
                    ForEach(messages, id: \.id) { message in
                        Button { onSelect(message.id) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text(chat?.participant(message.senderId)?.shownName ?? "Former member").font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Text(ChatTime.listStamp(message.createdAt)).font(.caption).foregroundStyle(.secondary)
                                }
                                Text(message.preview).lineLimit(3).foregroundStyle(.primary)
                            }
                        }
                        .accessibilityIdentifier("\(starred ? "stars" : "pins").row.\(message.id)")
                        .swipeActions {
                            Button(starred ? "Unstar" : "Unpin", role: .destructive) {
                                Task {
                                    if starred { try? await env.messages.setStar(false, messageId: message.id, in: chatId) }
                                    else { try? await env.messages.setPin(false, messageId: message.id, in: chatId) }
                                }
                            }
                        }
                    }
                }
            }
            .overlay {
                if phase == .loaded, messages.isEmpty {
                    ContentUnavailableView(starred ? "No starred messages" : "No pinned messages",
                                           systemImage: starred ? "star" : "pin",
                                           description: Text(starred ? "Star a message to find it here later. Only you can see your stars." : "Pinned messages show here for everyone in the chat."))
                        .accessibilityIdentifier("\(starred ? "stars" : "pins").empty")
                }
            }
            .accessibilityIdentifier(starred ? "stars.list" : "pins.list")
            .navigationTitle(starred ? "Starred" : "Pinned")
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
        }
    }

    private func load() async {
        phase = .loading
        do {
            if starred { try await env.messages.loadStars(chatId) } else { try await env.messages.loadPins(chatId) }
            phase = .loaded
        } catch {
            phase = .failed(APIError.from(error).message)
        }
    }
}

/// Forward a message to up to `ChatStore.maxForwardTargets` chats, then
/// show how each one went (they succeed or fail individually).
struct ForwardSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let sourceChatId: Int
    let message: Message

    @State private var selected: [Int] = []
    @State private var query = ""
    @State private var sending = false
    @State private var outcomes: [MessageStore.ForwardOutcome]?
    @State private var errorMessage: String?
    /// One key per forward attempt, so Retry only fills in what's missing.
    @State private var clientId = PendingMessage.makeClientId()

    var body: some View {
        let me = env.auth.user?.id
        NavigationStack {
            List {
                Section {
                    Text(message.preview).lineLimit(3).foregroundStyle(.secondary)
                } header: { Text("Message") }
                if let errorMessage {
                    ErrorBanner(message: errorMessage, identifier: "forward.error").listRowBackground(Color.clear)
                }
                if let outcomes {
                    Section("Results") {
                        ForEach(outcomes) { outcome in
                            HStack {
                                Text(env.chats.chat(outcome.chatId)?.displayName(me: me) ?? "Chat")
                                Spacer()
                                if let error = outcome.error {
                                    Label(error, systemImage: "xmark.circle.fill").foregroundStyle(.red).font(.footnote)
                                } else {
                                    Label("Sent", systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.footnote)
                                }
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("\(env.chats.chat(outcome.chatId)?.displayName(me: me) ?? "Chat"), \(outcome.error.map { "not sent: \($0)" } ?? "Sent")")
                            .accessibilityIdentifier("forward.result.\(outcome.chatId)")
                        }
                    }
                } else {
                    Section("Send to (\(selected.count)/\(ChatStore.maxForwardTargets))") {
                        ForEach(candidates(me: me), id: \.id) { chat in
                            Button { toggle(chat.id) } label: {
                                HStack(spacing: 10) {
                                    ChatAvatar(chat: chat, size: 34)
                                    Text(chat.displayName(me: me)).foregroundStyle(.primary)
                                    Spacer()
                                    Image(systemName: selected.contains(chat.id) ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(selected.contains(chat.id) ? Color.accentColor : .secondary)
                                }
                            }
                            .disabled(!selected.contains(chat.id) && selected.count >= ChatStore.maxForwardTargets)
                            .accessibilityAddTraits(selected.contains(chat.id) ? .isSelected : [])
                            .accessibilityIdentifier("forward.chat.\(chat.id)")
                        }
                    }
                }
            }
            .searchable(text: $query, prompt: "Search chats")
            .navigationTitle("Forward")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(outcomes == nil ? "Cancel" : "Done") { dismiss() }.accessibilityIdentifier("forward.cancel")
                }
                if outcomes == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        if sending { ProgressView() } else {
                            Button("Send") { Task { await send() } }
                                .disabled(selected.isEmpty)
                                .accessibilityIdentifier("forward.send")
                        }
                    }
                }
            }
            .task { if env.chats.list.ids.isEmpty { await env.chats.loadList(reset: false) } }
        }
    }

    private func candidates(me: Int?) -> [Chat] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return env.chats.list.ids.compactMap { env.chats.chat($0) }
            .filter { needle.isEmpty || $0.displayName(me: me).lowercased().contains(needle) }
    }

    private func toggle(_ id: Int) {
        if let index = selected.firstIndex(of: id) { selected.remove(at: index) }
        else if selected.count < ChatStore.maxForwardTargets { selected.append(id) }
    }

    private func send() async {
        sending = true
        errorMessage = nil
        defer { sending = false }
        do {
            outcomes = try await env.messages.forward(message.id, from: sourceChatId, to: selected, clientId: clientId)
            env.invalidations.invalidate(.chats)
        } catch {
            errorMessage = APIError.from(error).message
        }
    }
}
