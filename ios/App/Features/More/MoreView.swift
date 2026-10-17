import SwiftUI

/// The More tab: your profile, people, settings, (admins) the dashboard, and
/// which server this is.
struct MoreView: View {
    let environment: AppEnvironment
    let user: User
    @State private var confirmingLogout = false

    var body: some View {
        List {
            Section {
                NavigationLink(value: Route.profile(user.id)) {
                    HStack(spacing: 14) {
                        AvatarView(userId: user.id, size: 52, showsPresence: false)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(environment.users.user(user.id)?.shownName ?? user.shownName).font(.headline)
                                .accessibilityIdentifier("more.displayName")
                            Text("@\(user.username)").font(.subheadline).foregroundStyle(.secondary)
                                .accessibilityIdentifier("more.username")
                            UserStatusBadge(userId: user.id, font: .footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityIdentifier("more.profile")
            }
            Section {
                NavigationLink(value: Route.users) { Label("People", systemImage: "person.2") }
                    .accessibilityIdentifier("more.users")
                NavigationLink(value: Route.settings) { Label("Settings", systemImage: "gearshape") }
                    .accessibilityIdentifier("more.settings")
                // The server decides (403 otherwise); this only hides a dead end.
                if user.role == .admin {
                    NavigationLink(value: Route.admin) { Label("Admin dashboard", systemImage: "gauge.with.dots.needle.67percent") }
                        .accessibilityIdentifier("more.admin")
                }
            }
            Section("Server") {
                LabeledContent("Address", value: environment.config.apiBaseURL.absoluteString)
                    .accessibilityIdentifier("more.address")
                LabeledContent("Version") {
                    switch environment.server.state {
                    case .checking: Text("…")
                    case .online(let version): Text("v\(version)")
                    case .unreachable: Text("Unreachable").foregroundStyle(.red)
                    }
                }
                .accessibilityIdentifier("more.version")
            }
            Section {
                Button("Log out", role: .destructive) { confirmingLogout = true }
                    .accessibilityIdentifier("more.logout")
            }
        }
        .navigationTitle("More")
        .confirmationDialog("Log out of Chat Platform?", isPresented: $confirmingLogout, titleVisibility: .visible) {
            Button("Log out", role: .destructive) {
                Task { await environment.signOut() }
            }
            .accessibilityIdentifier("more.logout.confirm")
        }
        .task { await environment.users.ensure([user.id]) }
        .task { await environment.server.check() }
    }
}
