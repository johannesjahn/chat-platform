import SwiftUI

/// People: search by name (admins can also browse everyone), tap through to
/// a profile. `Route.users`.
struct UsersListView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model: UsersListModel?

    var body: some View {
        Group {
            if let model {
                UsersListContent(model: model)
            } else {
                Color.clear
            }
        }
        .navigationTitle("People")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if model == nil { model = UsersListModel(api: env.api, users: env.users) } }
    }
}

private struct UsersListContent: View {
    @Environment(AppEnvironment.self) private var env
    @Bindable var model: UsersListModel
    @State private var confirmingDelete: Int?
    @State private var errorMessage: String?
    @State private var messaging: Int?

    private var isAdmin: Bool { env.auth.user?.role == .admin }

    var body: some View {
        List {
            switch model.state {
            case .needsQuery:
                EmptyState(
                    title: "Find people", systemImage: "person.2",
                    message: "Type at least \(UserLimits.minSearchQuery) characters of a name to search.",
                    identifier: "users.prompt"
                )
                .listRowSeparator(.hidden)
            case .loading:
                SkeletonRows(count: 5)
            case .failed(let message):
                ErrorBanner(message: message, retry: { Task { await model.search(isAdmin: isAdmin) } }, identifier: "users.error")
                    .listRowSeparator(.hidden)
            case .loaded(let ids):
                if ids.isEmpty {
                    ContentUnavailableView.search(text: model.resultsQuery)
                        .accessibilityIdentifier("users.empty")
                        .listRowSeparator(.hidden)
                } else {
                    Section {
                        ForEach(ids, id: \.self) { id in row(id) }
                    } header: {
                        Text(model.resultsQuery.isEmpty ? "Everyone" : "Matching “\(model.resultsQuery)”")
                    }
                }
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("users.list")
        .searchable(
            text: $model.query, placement: .navigationBarDrawer(displayMode: .always),
            prompt: isAdmin ? "Search, or leave empty for everyone" : "Search people"
        )
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .refreshable { await model.search(isAdmin: isAdmin) }
        // Debounced: a new keystroke cancels the pending search.
        .task(id: model.query) {
            if model.state != .needsQuery || !model.query.isEmpty {
                try? await Task.sleep(for: .milliseconds(300))
                if Task.isCancelled { return }
            }
            await model.search(isAdmin: isAdmin)
        }
        // An account deleted elsewhere (its profile) or a reconnect: re-ask.
        .onChange(of: env.invalidations.token(.users)) {
            Task { await model.search(isAdmin: isAdmin) }
        }
        .confirmationDialog(
            "Permanently delete \(confirmingDelete.flatMap { env.users.user($0)?.label } ?? "this user")?",
            isPresented: Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete user", role: .destructive) {
                guard let id = confirmingDelete else { return }
                Task {
                    do {
                        try await UserActions.delete(id, env: env)
                        model.remove(id)
                    } catch { errorMessage = APIError.from(error).message }
                }
            }
            .accessibilityIdentifier("users.delete.confirm")
        } message: {
            Text("This removes their account, posts, comments, and messages, and can't be undone.")
        }
        .alert("Something went wrong", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK") {}
        } message: { Text(errorMessage ?? "") }
    }

    private func row(_ id: Int) -> some View {
        NavigationLink(value: Route.profile(id)) {
            UserRowLabel(userId: id)
        }
        .accessibilityIdentifier("users.row.\(id)")
        .swipeActions(edge: .trailing) {
            if id != env.auth.user?.id {
                if isAdmin {
                    Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = id }
                        .accessibilityIdentifier("users.row.\(id).delete")
                }
                Button("Message", systemImage: "message") { message(id) }
                    .tint(.accentColor)
                    .accessibilityIdentifier("users.row.\(id).message")
            }
        }
        .contextMenu {
            if id != env.auth.user?.id {
                Button("Message", systemImage: "message") { message(id) }
            }
        }
    }

    private func message(_ id: Int) {
        guard messaging == nil else { return }
        messaging = id
        Task {
            defer { messaging = nil }
            do { try await UserActions.message(id, env: env) } catch { errorMessage = APIError.from(error).message }
        }
    }
}
