import ChatAPI
import SwiftUI

/// Searches people by name (`GET /users/search`, three characters minimum).
@MainActor
@Observable
final class UserPicker {
    static let minQueryLength = 3
    var query = ""
    private(set) var results: [User] = []
    private(set) var isSearching = false
    private(set) var error: String?

    func search(api: APIClient, excluding: Set<Int>) async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= Self.minQueryLength else { results = []; error = nil; return }
        // Debounce: a newer keystroke cancels this task before it fires.
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        isSearching = true
        defer { isSearching = false }
        do {
            let found = try await api.call { try await $0.users_searchUsers(query: .init(q: q)) }.ok.body.json
            guard !Task.isCancelled else { return }
            results = found.filter { !excluding.contains($0.id) }
            error = nil
        } catch {
            let failure = APIError.from(error)
            if !failure.isCancelled { self.error = failure.message }
        }
    }
}

/// Start a conversation: a direct chat with one person, or a named group.
struct NewChatView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let onCreated: (Chat) -> Void

    enum Kind: String, CaseIterable, Identifiable {
        case direct = "Direct", group = "Group"
        var id: String { rawValue }
    }

    @State private var kind: Kind = .direct
    @State private var picker = UserPicker()
    @State private var title = ""
    @State private var selected: [User] = []
    @State private var pending = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Kind", selection: $kind) {
                        ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("newChat.kind")
                }
                if let errorMessage {
                    ErrorBanner(message: errorMessage, identifier: "newChat.error").listRowBackground(Color.clear)
                }
                if kind == .group {
                    Section("Group name") {
                        TextField("Weekend plans", text: $title)
                            .accessibilityIdentifier("newChat.title")
                    }
                    if !selected.isEmpty {
                        Section("Members (\(selected.count + 1)/\(ChatStore.maxGroupParticipants))") {
                            ForEach(selected, id: \.id) { user in
                                HStack {
                                    AvatarView(userId: user.id, size: 30)
                                    Text(user.shownName)
                                    Spacer()
                                    Button { selected.removeAll { $0.id == user.id } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                                        .buttonStyle(.plain)
                                        .accessibilityLabel("Remove \(user.shownName)")
                                        .accessibilityIdentifier("newChat.selected.\(user.id).remove")
                                }
                                .accessibilityIdentifier("newChat.selected.\(user.id)")
                            }
                        }
                    }
                }
                Section(kind == .direct ? "Message someone" : "Add people") {
                    TextField("Search by name or username", text: $picker.query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("newChat.search")
                    if picker.query.trimmingCharacters(in: .whitespaces).count < UserPicker.minQueryLength {
                        Text("Type at least \(UserPicker.minQueryLength) characters.").font(.footnote).foregroundStyle(.secondary)
                    } else if picker.isSearching && picker.results.isEmpty {
                        ProgressView()
                    } else if let error = picker.error {
                        ErrorBanner(message: error, identifier: "newChat.searchError")
                    } else if picker.results.isEmpty {
                        Text("Nobody found.").foregroundStyle(.secondary).accessibilityIdentifier("newChat.noResults")
                    }
                    ForEach(picker.results, id: \.id) { user in
                        Button { pick(user) } label: {
                            HStack(spacing: 10) {
                                AvatarView(userId: user.id, size: 34, showsPresence: true)
                                VStack(alignment: .leading) {
                                    Text(user.shownName).foregroundStyle(.primary)
                                    Text("@\(user.username)").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if kind == .group, selected.contains(where: { $0.id == user.id }) {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                        .disabled(pending)
                        .accessibilityIdentifier("newChat.user.\(user.id)")
                        .task { env.users.store(user) }
                    }
                }
            }
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.accessibilityIdentifier("newChat.cancel")
                }
                if kind == .group {
                    ToolbarItem(placement: .confirmationAction) {
                        if pending { ProgressView() } else {
                            Button("Create") { Task { await createGroup() } }
                                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || selected.isEmpty)
                                .accessibilityIdentifier("newChat.create")
                        }
                    }
                }
            }
            .task(id: picker.query) { await picker.search(api: env.api, excluding: [env.auth.user?.id ?? -1]) }
            .interactiveDismissDisabled(pending)
        }
    }

    private func pick(_ user: User) {
        switch kind {
        case .direct:
            Task { await createDirect(with: user) }
        case .group:
            if let index = selected.firstIndex(where: { $0.id == user.id }) { selected.remove(at: index) }
            else if selected.count + 1 < ChatStore.maxGroupParticipants { selected.append(user) }
        }
    }

    private func createDirect(with user: User) async {
        pending = true
        errorMessage = nil
        defer { pending = false }
        do { onCreated(try await env.chats.createDirect(with: user.id)) } catch { errorMessage = APIError.from(error).message }
    }

    private func createGroup() async {
        pending = true
        errorMessage = nil
        defer { pending = false }
        do {
            onCreated(try await env.chats.createGroup(title: title.trimmingCharacters(in: .whitespaces), participantIds: selected.map(\.id)))
        } catch {
            errorMessage = APIError.from(error).message
        }
    }
}

/// Join a group with an invite code — or a pasted invite link
/// (`…/chats/join/<code>`, as the web shares them).
struct JoinChatView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let onJoined: (Chat) -> Void
    var initialCode = ""

    @State private var code = ""
    @State private var pending = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Invite code or link", text: $code)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("join.code")
                } footer: {
                    Text("Ask a group's admin for an invite link, then paste it here.")
                }
                if let errorMessage {
                    ErrorBanner(message: errorMessage, identifier: "join.error").listRowBackground(Color.clear)
                }
                Section {
                    Button { Task { await join() } } label: {
                        HStack { Spacer(); if pending { ProgressView() } else { Text("Join chat") }; Spacer() }
                    }
                    .buttonStyle(.primary)
                    .listRowBackground(Color.clear)
                    .disabled(Self.code(from: code) == nil || pending)
                    .accessibilityIdentifier("join.submit")
                }
            }
            .navigationTitle("Join with code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.accessibilityIdentifier("join.cancel") }
            }
            .onAppear { if code.isEmpty { code = initialCode } }
        }
    }

    /// The code in a raw code or an invite link; nil if there's none.
    nonisolated static func code(from input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let url = URL(string: trimmed), url.scheme != nil {
            let parts = url.pathComponents.filter { $0 != "/" }
            if let index = parts.firstIndex(of: "join"), index + 1 < parts.count { return parts[index + 1] }
            return nil
        }
        guard trimmed.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else { return nil }
        return trimmed
    }

    private func join() async {
        guard let code = Self.code(from: code) else { return }
        pending = true
        errorMessage = nil
        defer { pending = false }
        do { onJoined(try await env.chats.join(code: code)) } catch { errorMessage = APIError.from(error).message }
    }
}
