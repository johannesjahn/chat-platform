import SwiftUI

/// Account settings, phone style: one list of sections, each its own screen
/// (the web's single settings page). `Route.settings`.
struct SettingsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var confirmingLogout = false

    var body: some View {
        @Bindable var theme = env.theme
        List {
            if let me = env.auth.user {
                Section {
                    NavigationLink(value: Route.profile(me.id)) {
                        HStack(spacing: 14) {
                            AvatarView(userId: me.id, size: 52)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(env.users.user(me.id)?.shownName ?? me.shownName).font(.headline)
                                Text("@\(me.username)").font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("settings.viewProfile")
                }
            }
            Section {
                NavigationLink { EditProfileView() } label: { Label("Profile", systemImage: "person.crop.circle") }
                    .accessibilityIdentifier("settings.profile")
                NavigationLink { StatusEditorView() } label: { Label("Status", systemImage: "face.smiling") }
                    .accessibilityIdentifier("settings.status")
                NavigationLink { BlockedUsersView() } label: { Label("Blocked & muted", systemImage: "hand.raised") }
                    .accessibilityIdentifier("settings.blocked")
            }
            Section {
                Picker("Theme", selection: $theme.preference) {
                    ForEach(ThemePreference.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("settings.theme")
            } header: {
                Text("Appearance")
            } footer: {
                Text("Applies to this device only.")
            }
            Section("Security") {
                NavigationLink { ChangePasswordView() } label: { Label("Change password", systemImage: "key") }
                    .accessibilityIdentifier("settings.password")
                NavigationLink { DeleteAccountView() } label: {
                    Label("Delete account", systemImage: "trash").foregroundStyle(.red)
                }
                .accessibilityIdentifier("settings.deleteAccount")
            }
            Section {
                Button("Log out", role: .destructive) { confirmingLogout = true }
                    .accessibilityIdentifier("settings.logout")
            }
        }
        .navigationTitle("Settings")
        .accessibilityIdentifier("settings.screen")
        .confirmationDialog("Log out of Chat Platform?", isPresented: $confirmingLogout, titleVisibility: .visible) {
            Button("Log out", role: .destructive) {
                Task { await env.signOut() }
            }
            .accessibilityIdentifier("settings.logout.confirm")
        }
    }
}

extension AppEnvironment {
    /// Logs out and forgets where every tab was, so the next account starts fresh.
    func signOut() async {
        await auth.logout()
        router.reset()
    }

    /// Writes a fresh copy of the signed-in user everywhere it's shown.
    func updateSignedInUser(_ user: User) async {
        users.store(user)
        await sessions.updateUser(user)
    }
}

/// A form's success or failure line.
struct FormMessage: View {
    enum Kind { case success, failure }
    let kind: Kind
    let text: String
    var identifier: String

    var body: some View {
        // Color only on the icon: green/red text is hard to read in light mode.
        Label {
            Text(text)
        } icon: {
            Image(systemName: kind == .success ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(kind == .success ? Color.green : Color.red)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}
