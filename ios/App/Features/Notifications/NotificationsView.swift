import SwiftUI

/// The Alerts tab: the notification inbox, newest first, paged by cursor.
/// A tap marks the row read and opens what it's about; a swipe or the
/// context menu marks it read in place; "Mark all read" clears the badge.
struct NotificationsView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        let store = env.notifications
        List {
            switch store.phase {
            case .idle, .loading:
                SkeletonRows(count: 5)
            case .failed(let message):
                ErrorBanner(message: message, retry: { Task { await store.load(reset: true) } }, identifier: "notifications.error")
                    .listRowSeparator(.hidden)
            case .loaded:
                ForEach(store.page.ids, id: \.self) { id in
                    if let item = store.notification(id) {
                        NotificationRowView(notification: item) { open(item) }
                            .swipeActions(edge: .trailing) {
                                if !item.read {
                                    Button { Task { await store.markRead(id) } } label: {
                                        Label("Mark read", systemImage: "envelope.open")
                                    }
                                    .tint(.accentColor)
                                    .accessibilityIdentifier("notifications.row.\(id).markRead")
                                }
                            }
                            .contextMenu {
                                if let route = NotificationPresentation.route(for: item) {
                                    Button("Open", systemImage: "arrow.up.right") { open(item, route: route) }
                                }
                                if !item.read {
                                    Button("Mark as read", systemImage: "envelope.open") { Task { await store.markRead(id) } }
                                }
                            }
                            .onAppear {
                                if id == store.page.ids.last { Task { await store.loadMore() } }
                            }
                    }
                }
                if store.isLoadingMore {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                        .accessibilityIdentifier("notifications.loadingMore")
                }
                if let error = store.loadMoreError {
                    ErrorBanner(message: error, retry: { Task { await store.loadMore() } }, identifier: "notifications.moreError")
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if store.phase == .loaded, store.page.ids.isEmpty {
                EmptyState(
                    title: "You're all caught up", systemImage: "bell.slash",
                    message: "When someone comments, replies, reacts, mentions you, or invites you to a game, it'll show up here.",
                    identifier: "notifications.empty"
                )
            }
        }
        .accessibilityIdentifier("notifications.list")
        .navigationTitle("Notifications")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await store.markAllRead() } } label: {
                    Label("Mark all read", systemImage: "checkmark.circle")
                }
                .disabled(store.unreadCount == 0)
                .accessibilityIdentifier("notifications.markAllRead")
            }
        }
        .refreshable { await store.load(reset: true) }
        .task(id: env.invalidations.token(.notifications)) { await store.load(reset: false) }
        .alert("Couldn't update", isPresented: Binding(get: { store.actionError != nil }, set: { if !$0 { store.actionError = nil } })) {
            Button("OK") {}
        } message: { Text(store.actionError ?? "") }
    }

    private func open(_ item: InboxNotification, route: Route? = nil) {
        if !item.read { Task { await env.notifications.markRead(item.id) } }
        if let target = route ?? NotificationPresentation.route(for: item) { env.router.push(target) }
    }
}

/// One inbox row: the actor's avatar with the type's badge, the sentence,
/// the server's excerpt, when, and an unread dot.
struct NotificationRowView: View {
    let notification: InboxNotification
    let onOpen: () -> Void
    @ScaledMetric(relativeTo: .body) private var avatarSize: CGFloat = 40

    var body: some View {
        let n = notification
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                AvatarView(userId: n.actor.id, size: avatarSize)
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: NotificationPresentation.symbol(for: n._type))
                            .font(.system(size: avatarSize * 0.24, weight: .bold))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: avatarSize * 0.46, height: avatarSize * 0.46)
                            .background(Circle().fill(Color(.systemBackground)))
                            .overlay(Circle().stroke(Color(.separator), lineWidth: 0.5))
                            .offset(x: 4, y: 4)
                            .accessibilityHidden(true)
                    }
                VStack(alignment: .leading, spacing: 3) {
                    headline(n)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    if let excerpt = n.excerpt {
                        Text("“\(excerpt)”")
                            .font(.subheadline)
                            .foregroundStyle(.primary.opacity(0.85))
                            .lineLimit(2)
                            .accessibilityIdentifier("notifications.row.\(n.id).excerpt")
                    }
                    Text(TimeText.relative(n.createdAt))
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !n.read {
                    Circle().fill(Color.accentColor).frame(width: 10, height: 10)
                        .padding(.top, 6)
                        .accessibilityHidden(true)
                }
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(n.read ? Color.clear : Color.accentColor.opacity(0.08))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(NotificationPresentation.accessibilityLabel(for: n))
        .accessibilityValue(n.read ? "read" : "unread")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("notifications.row.\(n.id)")
    }

    private func headline(_ n: InboxNotification) -> Text {
        var name = AttributedString(n.actor.shownName)
        name.inlinePresentationIntent = .stronglyEmphasized
        var rest = AttributedString(
            (n.actor.displayName?.isEmpty == false ? " @\(n.actor.username)" : "") + " " + NotificationPresentation.sentence(for: n)
        )
        rest.foregroundColor = .secondary
        return Text(name + rest)
    }
}
