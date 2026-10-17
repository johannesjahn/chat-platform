import SwiftUI

/// Unified search (`Route.search`, the magnifier on the Feed): people, posts,
/// comments and chat messages. "All" previews each kind from one request;
/// a kind's own tab pages through its endpoint. Results render the server's
/// highlighted snippets.
struct SearchView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model: SearchModel?
    @State private var text = ""
    @State private var scope: SearchScope = .all
    @FocusState private var searchFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let model {
                results(model)
            } else {
                Color.clear
            }
        }
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $text, placement: .navigationBarDrawer(displayMode: .always), prompt: "People, posts, comments, messages")
        .searchFocused($searchFocused)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .safeAreaInset(edge: .top, spacing: 0) { scopePicker }
        .task {
            if model == nil { model = SearchModel(api: env.api) }
            searchFocused = true
        }
        // A newer keystroke (or tab) cancels the running one mid-debounce.
        .task(id: Key(text: text, scope: scope, ready: model != nil)) {
            await model?.update(text: text, scope: scope)
        }
    }

    private struct Key: Hashable {
        var text: String
        var scope: SearchScope
        var ready: Bool
    }

    private var scopePicker: some View {
        ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(SearchScope.allCases, id: \.self) { item in
                    let selected = item == scope
                    Button { scope = item } label: {
                        Text(item.title)
                            .font(.subheadline.weight(selected ? .semibold : .regular))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .foregroundStyle(selected ? Color("OnAccent") : Color.primary)
                            .background(selected ? Color.accentColor : Color(.tertiarySystemFill), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("search.scope.\(item.rawValue)")
                    .id(item)
                }
            }
            .padding(.horizontal).padding(.vertical, 8)
        }
        .accessibilityIdentifier("search.scopes")
        // "See all" can pick a tab that's scrolled out of view.
        .onChange(of: scope) { _, selected in
            withAnimation(reduceMotion ? nil : .default) { proxy.scrollTo(selected, anchor: .center) }
        }
        }
        .background(.bar)
    }

    @ViewBuilder
    private func results(_ model: SearchModel) -> some View {
        let typed = SearchModel.normalize(text)
        let pending = typed.count >= SearchModel.minQueryLength && typed != model.query
        if typed.count < SearchModel.minQueryLength {
            EmptyState(
                title: "Search", systemImage: "magnifyingglass",
                message: "Type at least \(SearchModel.minQueryLength) characters to search. Matches happen anywhere inside a word from \(SearchModel.minFragmentLength) characters up.",
                identifier: "search.hint"
            )
        } else if scope == .all {
            overview(model, pending: pending)
        } else {
            paged(model, scope: scope, pending: pending)
        }
    }

    // MARK: All

    @ViewBuilder
    private func overview(_ model: SearchModel, pending: Bool) -> some View {
        if model.all == nil, pending || model.allPhase == .loading || model.allPhase == .idle {
            searching
        } else if case .failed(let message) = model.allPhase {
            List {
                ErrorBanner(message: message, retry: { Task { await model.load(.all, force: true) } }, identifier: "search.error")
                    .listRowSeparator(.hidden)
            }
            .listStyle(.plain)
        } else if model.overviewIsEmpty {
            noResults(model.query)
        } else {
            List {
                ForEach([SearchScope.users, .posts, .comments, .messages], id: \.self) { kind in
                    let section = model.overview(kind)
                    Section {
                        if section.hits.isEmpty {
                            Text(emptyLabel(kind, model: model)).font(.subheadline).foregroundStyle(.secondary)
                                .accessibilityIdentifier("search.section.\(kind.rawValue).empty")
                        }
                        ForEach(section.hits) { hit in row(hit, model: model) }
                        if section.hasMore {
                            Button("See all \(kind.sectionTitle.lowercased())") { scope = kind }
                                .font(.subheadline.weight(.semibold))
                                .accessibilityIdentifier("search.seeAll.\(kind.rawValue)")
                        }
                    } header: {
                        sectionHeader(kind, count: section.hits.count, more: section.hasMore)
                    }
                }
            }
            .listStyle(.plain)
            .opacity(pending || model.isRefreshingAll ? 0.6 : 1)
            .animation(.easeOut(duration: 0.2), value: pending || model.isRefreshingAll)
            .accessibilityIdentifier("search.results")
        }
    }

    private func sectionHeader(_ kind: SearchScope, count: Int, more: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: kind.symbol).accessibilityHidden(true)
            Text(kind.sectionTitle)
            if count > 0 {
                Text("\(count)\(more ? "+" : "")").foregroundStyle(.secondary)
                    .accessibilityLabel(more ? "\(count) or more" : "\(count)")
            }
        }
        .font(.footnote.weight(.semibold))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("search.section.\(kind.rawValue)")
    }

    // MARK: one kind

    @ViewBuilder
    private func paged(_ model: SearchModel, scope kind: SearchScope, pending: Bool) -> some View {
        let list = model.list(kind)
        if pending || list.phase == .idle || list.phase == .loading {
            searching
        } else if case .failed(let message) = list.phase {
            List {
                ErrorBanner(message: message, retry: { Task { await model.load(kind, force: true) } }, identifier: "search.error")
                    .listRowSeparator(.hidden)
            }
            .listStyle(.plain)
        } else if list.items.isEmpty {
            EmptyState(title: "No \(kind.sectionTitle.lowercased())", systemImage: kind.symbol,
                       message: emptyLabel(kind, model: model), identifier: "search.empty")
        } else {
            List {
                Section {
                    ForEach(list.items) { hit in
                        row(hit, model: model)
                            .onAppear {
                                if hit.id == list.page.ids.last { Task { await model.loadMore(kind) } }
                            }
                    }
                    if list.isLoadingMore {
                        ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                            .accessibilityIdentifier("search.loadingMore")
                    }
                    if let error = list.loadMoreError {
                        ErrorBanner(message: error, retry: { Task { await model.loadMore(kind) } }, identifier: "search.moreError")
                    }
                } header: {
                    sectionHeader(kind, count: 0, more: false)
                }
            }
            .listStyle(.plain)
            .accessibilityIdentifier("search.results")
        }
    }

    // MARK: pieces

    private var searching: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text("Searching…").foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("search.loading")
    }

    private func noResults(_ query: String) -> some View {
        ContentUnavailableView {
            Label("No results", systemImage: "magnifyingglass")
        } description: {
            Text("Nothing matches “\(query)”. Check the spelling or try a shorter word.")
        }
        .accessibilityIdentifier("search.noResults")
    }

    private func emptyLabel(_ kind: SearchScope, model: SearchModel) -> String {
        switch kind {
        case .users:
            env.auth.user?.role != .admin && model.query.count < SearchModel.minPeopleQueryLength
                ? "Type at least \(SearchModel.minPeopleQueryLength) characters to search people."
                : "No matching people."
        case .posts: "No matching posts."
        case .comments: "No matching comments."
        case .messages: "No matching messages in your chats."
        case .all: "No results."
        }
    }

    private func row(_ hit: SearchHit, model: SearchModel) -> some View {
        SearchHitRow(hit: hit, chatName: chatName(hit, model: model)) { env.router.push(hit.route) }
    }

    private func chatName(_ hit: SearchHit, model: SearchModel) -> String? {
        if case .message(let r) = hit { return model.chatName(r.chatId, viewer: env.auth.user?.id) }
        return nil
    }
}

/// One result: who (or which chat), when, and the highlighted snippet.
struct SearchHitRow: View {
    @Environment(AppEnvironment.self) private var env
    let hit: SearchHit
    var chatName: String?
    let onOpen: () -> Void
    @ScaledMetric(relativeTo: .body) private var avatarSize: CGFloat = 36

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                avatar
                VStack(alignment: .leading, spacing: 3) {
                    heading
                    if let detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                    if case .user = hit {} else {
                        SnippetText(segments: hit.snippet, identifier: "search.result.\(hit.id).snippet")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("search.result.\(hit.id)")
        .task(id: hit.id) {
            // Seed the shared cache so avatars draw without a request each.
            if let person, env.users.user(person.id) == nil { env.users.store(person) }
        }
    }

    private var person: User? {
        switch hit {
        case .user(let r): r.user
        case .post(let r): r.author
        case .comment(let r): r.author
        case .message(let r): r.sender
        }
    }

    @ViewBuilder
    private var avatar: some View {
        if case .message = hit {
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.system(size: avatarSize * 0.42))
                .foregroundStyle(Color.accentColor)
                .frame(width: avatarSize, height: avatarSize)
                .background(Circle().fill(Color.accentColor.opacity(0.15)))
                .accessibilityHidden(true)
        } else {
            AvatarView(userId: person?.id, size: avatarSize)
        }
    }

    @ViewBuilder
    private var heading: some View {
        switch hit {
        case .user(let r):
            // A person's snippet *is* their (highlighted) name.
            SnippetText(segments: r.snippet, lineLimit: 1, identifier: "search.result.\(hit.id).snippet")
                .font(.body.weight(.semibold))
        default:
            HStack(spacing: 6) {
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                if let handle { Text(handle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1) }
                Spacer(minLength: 4)
                Text(TimeText.relative(createdAt)).font(.caption).foregroundStyle(.secondary)
                    .layoutPriority(1)
            }
        }
    }

    private var title: String {
        if case .message = hit { return chatName ?? "Chat" }
        guard let person else { return "" }
        return person.displayName?.isEmpty == false ? person.displayName! : "@\(person.username)"
    }

    private var handle: String? {
        if case .message = hit { return nil }
        guard let person, person.displayName?.isEmpty == false else { return nil }
        return "@\(person.username)"
    }

    private var detail: String? {
        switch hit {
        case .user(let r):
            var line = "@\(r.user.username)"
            let status = [r.user.statusEmoji, r.user.statusText].compactMap { $0 }.joined(separator: " ")
            if !status.isEmpty { line += "  \(status)" }
            return line
        case .comment(let r): return r.parentCommentId != nil ? "Reply" : nil
        case .message(let r):
            let name = r.sender.displayName?.isEmpty == false ? "\(r.sender.displayName!) @\(r.sender.username)" : "@\(r.sender.username)"
            return name
        case .post: return nil
        }
    }

    private var createdAt: Int {
        switch hit {
        case .user: 0
        case .post(let r): r.createdAt
        case .comment(let r): r.createdAt
        case .message(let r): r.createdAt
        }
    }
}
