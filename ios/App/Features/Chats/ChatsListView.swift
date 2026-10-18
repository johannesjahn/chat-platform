import ChatAPI
import SwiftUI

/// The Chats tab: every conversation, newest activity first, with unread
/// counts, a search box and an All/Unread/Groups filter.
struct ChatsListView: View {
    @Environment(AppEnvironment.self) private var env

    enum Filter: String, CaseIterable, Identifiable {
        case all = "All", unread = "Unread", groups = "Groups"
        var id: String { rawValue }
    }

    enum Sheet: String, Identifiable {
        case newChat, join
        var id: String { rawValue }
    }

    @State private var query = ""
    @State private var filter: Filter = .all
    @State private var sheet: Sheet?
    @State private var leaving: Chat?
    @State private var errorMessage: String?

    var body: some View {
        let store = env.chats
        List {
            switch store.phase {
            case .idle, .loading:
                SkeletonRows()
            case .failed(let message):
                ErrorBanner(message: message, retry: { Task { await store.loadList(reset: true) } }, identifier: "chats.error")
                    .listRowSeparator(.hidden)
            case .loaded:
                if !store.list.ids.isEmpty {
                    Picker("Show", selection: $filter) {
                        ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowSeparator(.hidden)
                    .accessibilityIdentifier("chats.filter")
                }
                ForEach(shown, id: \.id) { chat in
                    ChatRow(chat: chat)
                        .swipeActions(edge: .leading) {
                            if chat.unreadCount > 0, let last = chat.lastMessage {
                                Button { markRead(chat.id, upTo: last.id) } label: { Label("Read", systemImage: "envelope.open") }
                                    .tint(.blue)
                                    .accessibilityIdentifier("chat.row.\(chat.id).markRead")
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            if chat.isGroup {
                                Button(role: .destructive) { leaving = chat } label: { Label("Leave", systemImage: "rectangle.portrait.and.arrow.right") }
                                    .accessibilityIdentifier("chat.row.\(chat.id).leave")
                            }
                        }
                        .onAppear { if chat.id == store.list.ids.last { Task { await store.loadMore() } } }
                }
                if !store.list.ids.isEmpty, shown.isEmpty {
                    Text("No chats match.").foregroundStyle(.secondary).frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden).accessibilityIdentifier("chats.noMatch")
                }
                if store.isLoadingMore { ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden) }
                if let error = store.loadMoreError {
                    ErrorBanner(message: error, retry: { Task { await store.loadMore() } }, identifier: "chats.moreError")
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if store.phase == .loaded, store.list.ids.isEmpty {
                ContentUnavailableView {
                    Label("No conversations yet", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Start a direct message or a group with people you know.")
                } actions: {
                    Button("New chat") { sheet = .newChat }.buttonStyle(.primary).accessibilityIdentifier("chats.empty.new")
                    Button("Join with code") { sheet = .join }.accessibilityIdentifier("chats.empty.join")
                }
                .accessibilityIdentifier("chats.empty")
            }
        }
        .searchable(text: $query, prompt: "Search chats")
        .accessibilityIdentifier("chats.list")
        .navigationTitle("Chats")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { sheet = .join } label: { Image(systemName: "link.badge.plus") }
                    .accessibilityLabel("Join with code")
                    .accessibilityIdentifier("chats.join")
            }
            ToolbarItem(placement: .primaryAction) {
                Button { sheet = .newChat } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New chat")
                    .accessibilityIdentifier("chats.new")
            }
        }
        .refreshable { await store.loadList(reset: true) }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .newChat: NewChatView { open($0) }
            case .join: JoinChatView { open($0) }
            }
        }
        .confirmationDialog("Leave this group?", isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }), titleVisibility: .visible, presenting: leaving) { chat in
            Button("Leave", role: .destructive) {
                Task {
                    do { try await env.chats.leave(chat.id) } catch { errorMessage = APIError.from(error).message }
                }
            }
            .accessibilityIdentifier("chats.leave.confirm")
        } message: { _ in Text("You'll stop getting its messages.") }
        .alert("Something went wrong", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK") {}
        } message: { Text(errorMessage ?? "") }
    }

    private var shown: [Chat] {
        let me = env.auth.user?.id
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return env.chats.list.ids.compactMap { env.chats.chat($0) }.filter { chat in
            if filter == .unread, chat.unreadCount == 0 { return false }
            if filter == .groups, !chat.isGroup { return false }
            return needle.isEmpty || chat.displayName(me: me).lowercased().contains(needle)
        }
    }

    private func open(_ chat: Chat) {
        sheet = nil
        env.router.push(.chat(chat.id, messageId: nil))
    }

    private func markRead(_ chatId: Int, upTo messageId: Int) {
        Task {
            do { try await env.chats.markRead(chatId, upTo: messageId) } catch { errorMessage = APIError.from(error).message }
        }
    }
}

/// One conversation in the list.
struct ChatRow: View {
    @Environment(AppEnvironment.self) private var env
    let chat: Chat

    var body: some View {
        let me = env.auth.user?.id
        let name = chat.displayName(me: me)
        let typists = env.typing.typists(in: chat.id)
        let hasUnread = chat.unreadCount > 0
        Button { env.router.push(.chat(chat.id, messageId: nil)) } label: {
            HStack(spacing: 12) {
                ChatAvatar(chat: chat, size: 50)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(name).font(.body.weight(hasUnread ? .bold : .semibold)).lineLimit(1)
                        Spacer(minLength: 4)
                        if let last = chat.lastMessage {
                            Text(ChatTime.listStamp(last.createdAt)).font(.caption)
                                .foregroundStyle(hasUnread ? Color.accentColor : .secondary)
                        }
                    }
                    HStack(alignment: .center, spacing: 6) {
                        Group {
                            if let sentence = TypingStore.sentence(for: typists) {
                                Text(sentence).italic().foregroundStyle(Color.accentColor)
                            } else {
                                Text(preview(me: me)).foregroundStyle(hasUnread ? .primary : .secondary)
                            }
                        }
                        .font(.subheadline).lineLimit(2)
                        Spacer(minLength: 4)
                        if hasUnread {
                            Text(chat.unreadCount > 99 ? "99+" : "\(chat.unreadCount)")
                                .font(.caption.weight(.bold)).monospacedDigit()
                                .foregroundStyle(Color("OnAccent"))
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .frame(minWidth: 22)
                                .background(Color.accentColor, in: Capsule())
                                .accessibilityIdentifier("chat.row.\(chat.id).unread")
                        }
                    }
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText(name: name, me: me))
        .accessibilityIdentifier("chat.row.\(chat.id)")
    }

    private func preview(me: Int?) -> String {
        guard let last = chat.lastMessage else { return "No messages yet" }
        var text = last.preview
        if last.forwardedFrom != nil { text = "↪︎ " + text }
        if last.senderId == me { return "You: " + text }
        if chat.isGroup, let sender = chat.participant(last.senderId) { return "\(sender.shownName): " + text }
        return text
    }

    private func accessibilityText(name: String, me: Int?) -> String {
        var parts = [name]
        if !chat.isGroup, let other = chat.other(than: me), env.users.isOnline(other.userId) { parts.append("online") }
        if chat.unreadCount > 0 { parts.append("\(chat.unreadCount) unread") }
        parts.append(preview(me: me))
        return parts.joined(separator: ", ")
    }
}

enum ChatTime {
    /// Today → a time, otherwise a short date — the chat-list convention.
    static func listStamp(_ millis: Int, now: Date = Date(), calendar: Calendar = .current) -> String {
        let date = TimeText.date(millis)
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// "Today", "Yesterday", "Mon, Jul 21", with the year once it isn't this one.
    static func daySeparator(_ millis: Int, now: Date = Date(), calendar: Calendar = .current) -> String {
        let date = TimeText.date(millis)
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().year())
    }

    static func bubbleTime(_ millis: Int) -> String {
        TimeText.date(millis).formatted(date: .omitted, time: .shortened)
    }
}
