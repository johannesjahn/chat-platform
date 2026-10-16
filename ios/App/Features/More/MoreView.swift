import SwiftUI

struct MoreView: View {
    let environment: AppEnvironment
    let user: User
    @State private var confirmingLogout = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        Image(systemName: "person.crop.circle.fill").font(.system(size: 44)).foregroundStyle(.tint)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(user.displayName ?? user.username).font(.headline)
                                .accessibilityIdentifier("more.displayName")
                            Text("@\(user.username)").font(.subheadline).foregroundStyle(.secondary)
                                .accessibilityIdentifier("more.username")
                        }
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
                    Task { await environment.auth.logout() }
                }
                .accessibilityIdentifier("more.logout.confirm")
            }
            .task { await environment.server.check() }
        }
    }
}
