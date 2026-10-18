import ChatAPI
import SwiftUI

/// `PUT /users/me/status`: emoji + message, optionally clearing itself.
struct StatusEditorView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var draft = StatusDraft()
    @State private var saving = false
    @State private var message: (kind: FormMessage.Kind, text: String)?
    @State private var seeded = false

    private var hasExisting: Bool { env.auth.user.map { env.users.status(of: $0.id) != nil } ?? false }

    var body: some View {
        Form {
            if let message { FormMessage(kind: message.kind, text: message.text, identifier: "settings.status.message") }
            if let me = env.auth.user, hasExisting {
                Section("Current") {
                    UserStatusBadge(userId: me.id, font: .body, showsExpiry: true, identifier: "settings.status.current")
                }
            }
            Section {
                HStack(spacing: 12) {
                    TextField("🎯", text: $draft.emoji)
                        .frame(width: 52)
                        .multilineTextAlignment(.center)
                        .onChange(of: draft.emoji) { _, value in
                            let clamped = value.clamped(toJSLength: UserLimits.maxStatusEmoji)
                            if clamped != value { draft.emoji = clamped }
                        }
                        .accessibilityLabel("Status emoji")
                        .accessibilityIdentifier("settings.status.emoji")
                    Divider()
                    TextField("What's happening?", text: $draft.text)
                        .onChange(of: draft.text) { _, value in
                            let clamped = value.clamped(toJSLength: UserLimits.maxStatusText)
                            if clamped != value { draft.text = clamped }
                        }
                        .accessibilityLabel("Status message")
                        .accessibilityIdentifier("settings.status.text")
                }
                Picker("Clear after", selection: $draft.expiry) {
                    ForEach(StatusExpiry.allCases) { Text($0.label).tag($0) }
                }
                .accessibilityIdentifier("settings.status.expiry")
            } footer: {
                Text("Shown next to your name in chats and on your profile.")
            }
            Section {
                Button {
                    guard let request = draft.saveRequest else { return }
                    Task { await send(request, done: "Status updated.") }
                } label: {
                    Text("Save status").frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
                .disabled(saving || !draft.hasContent)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .accessibilityIdentifier("settings.status.save")
                if hasExisting {
                    Button("Clear status", role: .destructive) {
                        Task { await send(.clear, done: "Status cleared.") }
                    }
                    .disabled(saving)
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("settings.status.clear")
                }
            }
        }
        .navigationTitle("Status")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !seeded, let me = env.auth.user else { return }
            seeded = true
            let status = env.users.status(of: me.id)
            draft.emoji = status?.emoji ?? ""
            draft.text = status?.text ?? ""
        }
    }

    private func send(_ request: UpdateStatusRequest, done: String) async {
        saving = true
        message = nil
        defer { saving = false }
        do {
            let user: User = try await env.api.sendJSON("PUT", path: "users/me/status", body: request)
            await env.updateSignedInUser(user)
            if request == .clear { draft = StatusDraft() }
            message = (.success, done)
        } catch {
            message = (.failure, APIError.from(error).message)
        }
    }
}

/// Everyone you've blocked or muted, with a way to lift each.
struct BlockedUsersView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var pending: Int?
    @State private var errorMessage: String?

    var body: some View {
        List {
            if let errorMessage { ErrorBanner(message: errorMessage, identifier: "blocked.error") }
            switch env.blocks.phase {
            case .idle, .loading:
                SkeletonRows(count: 3)
            case .failed(let message):
                ErrorBanner(message: message, retry: { Task { await load() } }, identifier: "blocked.loadError")
            case .loaded:
                ForEach(env.blocks.entries, id: \.user.id) { entry in
                    // Two borderless buttons, not a NavigationLink: a link
                    // swallows the row (and the lift button with it).
                    HStack(spacing: 12) {
                        Button { env.router.push(.profile(entry.user.id)) } label: {
                            HStack(spacing: 12) {
                                AvatarView(userId: entry.user.id, size: 40)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(env.users.user(entry.user.id)?.label ?? entry.user.label)
                                        .font(.body.weight(.medium)).lineLimit(1).foregroundStyle(.primary)
                                    Text(entry._type == .block ? "Blocked" : "Muted")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                        .tint(Color.primary)
                        .accessibilityIdentifier("blocked.row.\(entry.user.id)")
                        Button(entry._type == .block ? "Unblock" : "Unmute") { lift(entry.user.id) }
                            .buttonStyle(.bordered)
                            .disabled(pending == entry.user.id)
                            .accessibilityIdentifier("blocked.row.\(entry.user.id).lift")
                    }
                    .swipeActions {
                        Button(entry._type == .block ? "Unblock" : "Unmute") { lift(entry.user.id) }.tint(.accentColor)
                    }
                }
            }
        }
        .overlay {
            if env.blocks.phase == .loaded, env.blocks.entries.isEmpty {
                EmptyState(title: "Nobody blocked or muted", systemImage: "hand.raised",
                           message: "Block or mute someone from their profile.", identifier: "blocked.empty")
            }
        }
        .navigationTitle("Blocked & muted")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        if let me = env.auth.user { await env.blocks.load(for: me.id) }
    }

    private func lift(_ id: Int) {
        pending = id
        errorMessage = nil
        Task {
            defer { pending = nil }
            do { try await env.blocks.remove(id) } catch { errorMessage = APIError.from(error).message }
        }
    }
}

/// `POST /users/me/password`. Other devices are signed out; this one gets a
/// fresh token pair.
struct ChangePasswordView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var draft = PasswordDraft()
    @State private var saving = false
    @State private var message: (kind: FormMessage.Kind, text: String)?

    var body: some View {
        Form {
            if let message { FormMessage(kind: message.kind, text: message.text, identifier: "settings.password.message") }
            Section {
                SecureField("Current password", text: $draft.current)
                    .accessibilityIdentifier("settings.password.current")
                SecureField("New password", text: $draft.new)
                    .accessibilityIdentifier("settings.password.new")
                SecureField("Confirm new password", text: $draft.confirm)
                    .accessibilityIdentifier("settings.password.confirm")
            } footer: {
                if let problem = draft.problem {
                    Text(problem).foregroundStyle(.red).accessibilityIdentifier("settings.password.problem")
                } else {
                    Text("At least \(UserLimits.minPassword) characters. Changing it signs you out everywhere else.")
                }
            }
            Section {
                Button {
                    Task { await save() }
                } label: {
                    Text(saving ? "Please wait…" : "Change password").frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
                .disabled(saving || !draft.canSubmit)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .accessibilityIdentifier("settings.password.save")
            }
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .navigationTitle("Change password")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func save() async {
        saving = true
        message = nil
        defer { saving = false }
        let body = Components.Schemas.ChangePasswordBody(currentPassword: draft.current, newPassword: draft.new)
        do {
            let pair = try await env.api.call { try await $0.users_changePassword(body: .json(body)) }.ok.body.json
            if var session = await env.sessions.current() {
                session.accessToken = pair.accessToken
                session.refreshToken = pair.refreshToken
                await env.sessions.start(session)
            }
            draft = PasswordDraft()
            message = (.success, "Password changed.")
        } catch {
            message = (.failure, APIError.from(error).message)
        }
    }
}

/// `DELETE /users/me` — re-proves the password, then signs out for good.
struct DeleteAccountView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var password = ""
    @State private var confirming = false
    @State private var deleting = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                Text("Permanently deletes your account, posts, comments, and messages. This can't be undone.")
            }
            if let errorMessage { FormMessage(kind: .failure, text: errorMessage, identifier: "settings.delete.error") }
            Section("Confirm your password") {
                SecureField("Password", text: $password)
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("settings.delete.password")
            }
            Section {
                Button("Delete my account", role: .destructive) { confirming = true }
                    .frame(maxWidth: .infinity)
                    .disabled(password.isEmpty || deleting)
                    .accessibilityIdentifier("settings.delete.submit")
            }
        }
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Delete your account?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Delete account", role: .destructive) { Task { await delete() } }
                .accessibilityIdentifier("settings.delete.confirm")
        } message: {
            Text("Your profile, posts, comments, and messages are permanently removed and you'll be signed out.")
        }
    }

    private func delete() async {
        deleting = true
        errorMessage = nil
        defer { deleting = false }
        let body = Components.Schemas.DeleteAccountBody(password: password)
        do {
            _ = try await env.api.call { try await $0.users_deleteAccount(body: .json(body)) }
            // Every token died with the account; nothing to revoke.
            await env.sessions.clear()
            env.router.reset()
        } catch {
            errorMessage = APIError.from(error).message
        }
    }
}
