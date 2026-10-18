import ChatAPI
import SwiftUI

/// A conversation: the thread (paging both ways, grouped by day and
/// sender), the pinned bar, who's typing, and the composer. It marks what's
/// on screen as read while the app is in the foreground.
struct ConversationView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let chatId: Int
    let targetMessageId: Int?

    @State private var loadFailure: String?
    @State private var draft = ""
    @State private var replyTo: Message?
    @State private var editing: Message?
    @State private var highlighted: Int?
    @State private var handledTarget = false
    @State private var restoredPosition = false
    @State private var visibleIds: Set<Int> = []
    @State private var nearBottom = true
    @State private var lastMarkedRead = 0
    @State private var deleting: Message?
    @State private var forwarding: Message?
    @State private var sheet: Sheet?
    @State private var errorMessage: String?
    @State private var pendingJump: Int?
    @State private var scrollRequest: ScrollRequest?
    @FocusState private var composerFocused: Bool

    enum Sheet: String, Identifiable {
        case info, pins, stars
        var id: String { rawValue }
    }

    struct ScrollRequest: Equatable {
        var target: String
        var anchor: UnitPoint
        var animated: Bool
        var nonce = UUID()
    }

    var body: some View {
        Group {
            if env.chats.missing.contains(chatId) {
                EmptyState(title: "Chat not found", systemImage: "bubble.left.and.exclamationmark.bubble.right",
                           message: "It may have been deleted, or you're no longer in it.", identifier: "chat.missing")
            } else if let chat = env.chats.chat(chatId) {
                thread(chat)
            } else if let loadFailure {
                EmptyState(title: "Couldn't load chat", systemImage: "wifi.exclamationmark", message: loadFailure, identifier: "chat.error",
                           action: (title: "Try again", run: { Task { await load() } }))
            } else {
                ProgressView().accessibilityIdentifier("chat.loading")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .task(id: env.messages.window(chatId).revision) { await load() }
        .task(id: env.messages.window(chatId).pinsRevision) { try? await env.messages.loadPins(chatId) }
        .onDisappear { env.messages.window(chatId).lastVisibleMessageId = visibleIds.max() }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .info: ChatInfoView(chatId: chatId) { jump(to: $0) }
            case .pins: PinnedMessagesSheet(chatId: chatId, starred: false) { jump(to: $0) }
            case .stars: PinnedMessagesSheet(chatId: chatId, starred: true) { jump(to: $0) }
            }
        }
        .sheet(item: $forwarding) { ForwardSheet(sourceChatId: chatId, message: $0) }
        .confirmationDialog("Delete this message?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { message in
            Button("Delete", role: .destructive) {
                perform { try await env.messages.delete(message.id, in: chatId) }
            }
            .accessibilityIdentifier("message.delete.confirm")
        } message: { _ in Text("It's removed for everyone in the chat.") }
        .alert("Something went wrong", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK") {}
        } message: { Text(errorMessage ?? "") }
    }

    // MARK: loading

    private func load() async {
        async let chatResult: Void = loadChat()
        async let messagesResult: Void = loadMessages()
        _ = await (chatResult, messagesResult)
        await handleTarget()
    }

    private func loadChat() async {
        do {
            _ = try await env.chats.fetch(chatId)
            loadFailure = nil
        } catch let error as APIError where error.isNotFound || error.status == 403 {
            // `fetch` marked it missing.
        } catch {
            if env.chats.chat(chatId) == nil { loadFailure = APIError.from(error).message }
        }
    }

    private func loadMessages() async {
        do { try await env.messages.refresh(chatId) } catch { /* the window shows its own error */ }
    }

    /// Arriving with a message to show: page to it, scroll, highlight.
    private func handleTarget() async {
        guard !handledTarget, let targetMessageId, env.messages.window(chatId).list.hasLoaded else { return }
        handledTarget = true
        jump(to: targetMessageId)
    }

    private func jump(to messageId: Int) {
        sheet = nil
        Task {
            let found = await env.messages.loadUntil(chatId, contains: messageId)
            guard found else { errorMessage = "That message isn't available any more."; return }
            scrollRequest = ScrollRequest(target: "m\(messageId)", anchor: .center, animated: !reduceMotion)
            highlighted = messageId
            try? await Task.sleep(for: .seconds(2))
            if highlighted == messageId { highlighted = nil }
        }
    }

    // MARK: thread

    @ViewBuilder
    private func thread(_ chat: Chat) -> some View {
        let window = env.messages.window(chatId)
        let me = env.auth.user?.id
        let typists = env.typing.typists(in: chatId)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    threadHeader(window)
                    ForEach(ThreadRow.rows(window.list.messages, isGroup: chat.isGroup, me: me), id: \.message.id) { row in
                        VStack(spacing: 0) {
                            if let day = row.daySeparator {
                                Text(day).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                    .padding(.horizontal, 10).padding(.vertical, 4)
                                    .background(Color(.tertiarySystemFill), in: Capsule())
                                    .padding(.vertical, 10)
                                    .accessibilityAddTraits(.isHeader)
                            }
                            bubble(row, chat: chat)
                        }
                        .padding(.top, row.startsRun ? 6 : 0)
                        .id("m\(row.message.id)")
                    }
                    if window.list.hasNewer {
                        ProgressView().padding().id("newer")
                            .onAppear { Task { await env.messages.loadNewer(chatId) } }
                            .accessibilityIdentifier("chat.loadingNewer")
                    }
                    ForEach(window.pending) { pending in
                        PendingBubble(pending: pending,
                                      retry: { Task { await env.messages.retry(pending.clientId, in: chatId) } },
                                      discard: { env.messages.discard(pending.clientId, in: chatId) })
                            .id("p\(pending.clientId)")
                    }
                    if let sentence = TypingStore.sentence(for: typists) {
                        HStack {
                            TypingDots()
                            Text(sentence).font(.footnote).foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.horizontal, 16).padding(.vertical, 6)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("chat.typing")
                        .id("typing")
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .scrollTargetLayout()
            }
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.5) { ids in
                visibleIds = Set(ids.compactMap { $0.hasPrefix("m") ? Int($0.dropFirst()) : nil })
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 120
            } action: { _, isNear in nearBottom = isNear }
            .refreshable { await env.messages.loadEarlier(chatId) }
            .accessibilityIdentifier("chat.thread")
            .safeAreaInset(edge: .top, spacing: 0) { PinnedBar(chatId: chatId, onOpen: { jump(to: $0) }, onList: { sheet = .pins }) }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ChatComposer(chatId: chatId, draft: $draft, replyTo: $replyTo, editing: $editing, focused: $composerFocused) { text, file in
                    send(text, file: file)
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onChange(of: scrollRequest) { _, request in
                guard let request else { return }
                if request.animated { withAnimation { proxy.scrollTo(request.target, anchor: request.anchor) } }
                else { proxy.scrollTo(request.target, anchor: request.anchor) }
            }
            .onChange(of: window.list.newestId) { old, new in
                // Their message arrived: they've stopped typing.
                if let new, let message = window.list.message(new) { env.typing.clear(chatId: chatId, userId: message.senderId) }
                // Follow new messages while reading the newest ones.
                if old != nil, nearBottom, targetMessageId == nil || handledTarget {
                    if reduceMotion { proxy.scrollTo("bottom", anchor: .bottom) } else { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                }
            }
            .onChange(of: window.pending.count) { old, new in
                if new > old { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: typists.isEmpty) { _, empty in
                if !empty, nearBottom { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .task(id: window.list.hasLoaded) {
                // Reopening a chat: back to where the reader was.
                guard window.list.hasLoaded, !restoredPosition, targetMessageId == nil else { return }
                restoredPosition = true
                if let saved = window.lastVisibleMessageId, saved != window.list.newestId, window.list.contains(saved) {
                    proxy.scrollTo("m\(saved)", anchor: .bottom)
                }
            }
        }
        .task(id: ReadState(unread: chat.unreadCount, visibleNewest: visibleIds.max(), active: scenePhase == .active)) {
            await markRead(chat)
        }
        .toolbar {
            ToolbarItem(placement: .principal) { header(chat, typists: typists) }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Chat info", systemImage: "info.circle") { sheet = .info }.accessibilityIdentifier("chat.menu.info")
                    Button("Pinned messages", systemImage: "pin") { sheet = .pins }.accessibilityIdentifier("chat.menu.pins")
                    Button("Starred messages", systemImage: "star") { sheet = .stars }.accessibilityIdentifier("chat.menu.stars")
                } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("Chat options")
                    .accessibilityIdentifier("chat.menu")
            }
        }
    }

    @ViewBuilder
    private func threadHeader(_ window: MessageWindow) -> some View {
        switch window.phase {
        case .idle, .loading:
            VStack { SkeletonRows(count: 3) }.padding()
        case .failed(let message):
            ErrorBanner(message: message, retry: { Task { await load() } }, identifier: "chat.messages.error").padding()
        case .loaded:
            if window.list.hasEarlier {
                HStack { Spacer(); ProgressView(); Spacer() }
                    .padding(.vertical, 12)
                    .id("earlier")
                    .onAppear { Task { await env.messages.loadEarlier(chatId) } }
                    .accessibilityIdentifier("chat.loadingEarlier")
            } else if window.list.messages.isEmpty, window.pending.isEmpty {
                Text("No messages yet — say hi 👋").foregroundStyle(.secondary).padding(.vertical, 40)
                    .accessibilityIdentifier("chat.empty")
            } else {
                Text("Beginning of the conversation").font(.caption).foregroundStyle(.tertiary).padding(.vertical, 12)
                    .accessibilityIdentifier("chat.beginning")
            }
            if let error = window.pageError {
                ErrorBanner(message: error, retry: { Task { await env.messages.loadEarlier(chatId) } }, identifier: "chat.page.error").padding(.horizontal)
            }
        }
    }

    private func header(_ chat: Chat, typists: [TypingStore.Typist]) -> some View {
        let me = env.auth.user?.id
        let subtitle: String = {
            if let sentence = TypingStore.sentence(for: typists) { return sentence }
            if chat.isGroup { return "\(chat.participants.count) members" }
            if let other = chat.other(than: me), env.users.isOnline(other.userId) { return "Online" }
            return ""
        }()
        return Button { sheet = .info } label: {
            HStack(spacing: 8) {
                ChatAvatar(chat: chat, size: 32)
                VStack(alignment: .leading, spacing: 0) {
                    Text(chat.displayName(me: me)).font(.headline).lineLimit(1)
                    if !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(subtitle.isEmpty ? chat.displayName(me: me) : "\(chat.displayName(me: me)), \(subtitle)")
        .accessibilityHint("Shows chat info")
        .accessibilityIdentifier("chat.title")
    }

    private func bubble(_ row: ThreadRow, chat: Chat) -> some View {
        let message = row.message
        let me = env.auth.user
        let isOwn = message.senderId == me?.id
        let canDeleteOthers = ChatPermissions(chat: chat, me: me).canManage
        let canDelete = isOwn || canDeleteOthers || me?.role == .admin
        return MessageBubble(
            message: message,
            isOwn: isOwn,
            senderName: chat.participant(message.senderId)?.shownName ?? "Former member",
            showsSender: row.showsSender,
            highlighted: highlighted == message.id,
            actions: MessageActions(
                reply: { editing = nil; replyTo = message; composerFocused = true },
                react: { emoji in perform { try await env.messages.toggleReaction(emoji, on: message.id, in: chatId) } },
                edit: isOwn && message.contentType == .text ? { replyTo = nil; editing = message; draft = message.content; composerFocused = true } : nil,
                delete: canDelete ? { deleting = message } : nil,
                togglePin: { perform { try await env.messages.setPin(!message.pinned, messageId: message.id, in: chatId) } },
                toggleStar: { perform { try await env.messages.setStar(!message.starred, messageId: message.id, in: chatId) } },
                forward: { forwarding = message },
                jumpToParent: { jump(to: $0) }
            )
        )
    }

    // MARK: actions

    private func send(_ text: String, file: APIClient.UploadFile?) {
        if let editing {
            let id = editing.id
            self.editing = nil
            draft = ""
            perform { try await env.messages.edit(id, in: chatId, to: text) }
            return
        }
        let parent = replyTo
        let pending = PendingMessage(
            clientId: PendingMessage.makeClientId(), chatId: chatId,
            contentType: file == nil ? .text : .attachment,
            content: text.isEmpty ? (file?.filename ?? "") : text,
            parentMessageId: parent?.id,
            parentPreview: parent.map { "↩︎ \($0.preview)" },
            upload: file, createdAt: Date()
        )
        draft = ""
        replyTo = nil
        Task { await env.messages.send(pending) }
    }

    private func perform(_ work: @escaping () async throws -> Void) {
        Task {
            do { try await work() } catch { errorMessage = APIError.from(error).message }
        }
    }

    /// Marks read up to the newest message on screen — only while the app is
    /// in the foreground and there's something unread.
    private func markRead(_ chat: Chat) async {
        guard scenePhase == .active, chat.unreadCount > 0 else { return }
        let window = env.messages.window(chatId)
        guard let upTo = visibleIds.max() ?? (window.list.hasNewer ? nil : window.list.newestId), upTo > lastMarkedRead else { return }
        lastMarkedRead = upTo
        do { try await env.chats.markRead(chatId, upTo: upTo) } catch { lastMarkedRead = 0 }
    }
}

private struct ReadState: Equatable {
    var unread: Int
    var visibleNewest: Int?
    var active: Bool
}

/// How each message sits in the thread: a date separator before the first
/// message of a day, the sender's name on the first of a run in a group.
struct ThreadRow {
    var message: Message
    var daySeparator: String?
    var showsSender: Bool
    var startsRun: Bool

    /// A run breaks on another sender, a new day, or a 5-minute pause.
    static let runGap = 5 * 60 * 1000

    static func rows(_ messages: [Message], isGroup: Bool, me: Int?, now: Date = Date(), calendar: Calendar = .current) -> [ThreadRow] {
        var rows: [ThreadRow] = []
        rows.reserveCapacity(messages.count)
        var previous: Message?
        for message in messages {
            let newDay = previous.map { !calendar.isDate(TimeText.date($0.createdAt), inSameDayAs: TimeText.date(message.createdAt)) } ?? true
            let startsRun = newDay || previous?.senderId != message.senderId || message.createdAt - (previous?.createdAt ?? 0) > runGap
            rows.append(ThreadRow(
                message: message,
                daySeparator: newDay ? ChatTime.daySeparator(message.createdAt, now: now, calendar: calendar) : nil,
                showsSender: isGroup && startsRun && message.senderId != me,
                startsRun: startsRun
            ))
            previous = message
        }
        return rows
    }
}

/// Three dots that pulse (still, with Reduce Motion).
struct TypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.2, paused: reduceMotion)) { context in
            let phase = Int(context.date.timeIntervalSinceReferenceDate * 3) % 3
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { index in
                    Circle().fill(Color.secondary).frame(width: 6, height: 6)
                        .opacity(reduceMotion || index == phase ? 1 : 0.35)
                }
            }
        }
        .accessibilityHidden(true)
    }
}
