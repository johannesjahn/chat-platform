import SwiftUI

/// A game's icon on its gradient.
struct GameIcon: View {
    let game: GameDefinition
    var size: CGFloat = 44

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28)
            .fill(game.theme.gradient)
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: game.systemImage)
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(game.theme.onGradient)
            }
            .accessibilityHidden(true)
    }
}

/// A rounded card section, the shell every games screen is built from.
struct GamePanel<Content: View>: View {
    var title: String?
    var systemImage: String?
    var identifier: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title {
                Label(title, systemImage: systemImage ?? "circle")
                    .font(.headline)
                    .labelStyle(.titleAndIcon)
                    .accessibilityAddTraits(.isHeader)
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .contain)
        .modifier(OptionalIdentifier(identifier: identifier))
    }
}

struct OptionalIdentifier: ViewModifier {
    let identifier: String?
    func body(content: Content) -> some View {
        if let identifier { content.accessibilityIdentifier(identifier) } else { content }
    }
}

/// A filled, game-colored call to action (dark label on the gradient).
struct GameButtonStyle: ButtonStyle {
    let theme: GameTheme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(isEnabled ? theme.onGradient : Color.secondary)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .frame(minHeight: 44)
            .background {
                if isEnabled {
                    Capsule().fill(theme.gradient).opacity(configuration.isPressed ? 0.8 : 1)
                } else {
                    Capsule().fill(Color(.tertiarySystemFill))
                }
            }
            .contentShape(Capsule())
    }
}

struct PhaseBadge: View {
    let phase: GameLobbyPhase

    var body: some View {
        let (text, color): (String, Color) = switch phase {
        case .waiting: ("Waiting", .blue)
        case .countdown: ("Starting", .orange)
        case .racing: ("Live", .green)
        case .finished: ("Finished", .gray)
        }
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(color.opacity(0.15), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
        .accessibilityIdentifier("lobby.phase")
        .accessibilityValue(phase.rawValue)
    }
}

/// A gold/silver/bronze medal with the place in it.
struct PlaceBadge: View {
    let place: Int
    var size: CGFloat = 28

    static func color(_ place: Int) -> Color {
        switch place {
        case 1: Color(red: 0.95, green: 0.74, blue: 0.16)
        case 2: Color(red: 0.72, green: 0.75, blue: 0.80)
        case 3: Color(red: 0.80, green: 0.52, blue: 0.30)
        default: Color(.tertiarySystemFill)
        }
    }

    var body: some View {
        Circle().fill(Self.color(place))
            .frame(width: size, height: size)
            .overlay {
                Text("\(place)").font(.system(size: size * 0.45, weight: .bold)).monospacedDigit()
                    .foregroundStyle(place <= 3 ? Color(red: 0.12, green: 0.1, blue: 0.08) : Color.primary)
            }
            .accessibilityLabel(GameFormat.ordinal(place) + " place")
    }
}

/// A labelled number in the games' stat strips.
struct StatTile: View {
    let label: String
    let value: String
    var emphasis: Color?
    var identifier: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.semibold)).textCase(.uppercase).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(value).font(.title3.weight(.bold)).monospacedDigit()
                .foregroundStyle(emphasis ?? .primary)
                .lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color(.tertiarySystemFill).opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
        .modifier(OptionalIdentifier(identifier: identifier))
    }
}

/// The big 3-2-1 over a play area until the start. Driven by the server's
/// `startsAt` on the corrected clock, so every player sees the same second.
struct CountdownOverlay: View {
    let startsAt: Int?
    let now: Double
    var hint: String?
    let theme: GameTheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let seconds = LobbyTiming.countdownSeconds(startsAt: startsAt, now: now) {
            VStack(spacing: 8) {
                Text("\(seconds)")
                    .font(.system(size: 88, weight: .black, design: .rounded))
                    .foregroundStyle(theme.gradient)
                    .contentTransition(reduceMotion ? .identity : .numericText(countsDown: true))
                    .animation(reduceMotion ? nil : .snappy, value: seconds)
                Text("Get ready").font(.headline)
                if let hint { Text(hint).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Starting in \(seconds)")
            .accessibilityIdentifier("lobby.countdown")
        }
    }
}

/// Seated players, in join order.
struct LobbySeats: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let meId: Int?

    var body: some View {
        VStack(spacing: 8) {
            ForEach(lobby.players, id: \.user.id) { player in
                HStack(spacing: 10) {
                    AvatarView(userId: player.user.id, size: 34)
                    Text(player.user.id == meId ? "\(player.user.shownName) (you)" : player.user.shownName)
                        .font(.subheadline.weight(.medium)).lineLimit(1)
                    Spacer()
                    if player.user.id == lobby.hostId {
                        Label("Host", systemImage: "crown.fill").font(.caption.weight(.semibold))
                            .foregroundStyle(PlaceBadge.color(1))
                            .labelStyle(.titleAndIcon)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("lobby.seat.\(player.user.id)")
            }
            ForEach(0..<max(0, min(lobby.maxPlayers, 8) - lobby.players.count), id: \.self) { _ in
                HStack(spacing: 10) {
                    Circle().strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [4])).foregroundStyle(.tertiary)
                        .frame(width: 34, height: 34)
                    Text("Open seat").font(.subheadline).foregroundStyle(.tertiary)
                    Spacer()
                }
                .accessibilityHidden(true)
            }
        }
    }
}

/// A finished game's results: the top three on a podium, everyone (and who
/// didn't finish) listed below. Game-agnostic — it shows each player's
/// server-scored `score` in the game's unit.
struct ResultsPodium: View {
    let lobby: GameLobby
    let game: GameDefinition
    let meId: Int?

    var body: some View {
        let finishers = lobby.players.filter { $0.place != nil }.sorted { ($0.place ?? 0) < ($1.place ?? 0) }
        let dnf = lobby.players.filter { $0.place == nil }
        VStack(spacing: 16) {
            HStack(alignment: .bottom, spacing: 8) {
                ForEach([2, 1, 3], id: \.self) { place in
                    column(place: place, player: finishers.first { $0.place == place })
                }
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("results.podium")
            VStack(spacing: 6) {
                ForEach(finishers + dnf, id: \.user.id) { player in row(player) }
            }
        }
    }

    private func column(place: Int, player: GameLobbyPlayer?) -> some View {
        VStack(spacing: 6) {
            if let player {
                AvatarView(userId: player.user.id, size: place == 1 ? 52 : 42)
                Text(player.user.shownName).font(.caption.weight(.semibold)).lineLimit(1)
                    .foregroundStyle(player.user.id == meId ? game.theme.accentText : .primary)
                Text("\(Int((player.score ?? 0).rounded())) \(game.scoreUnit)").font(.caption2).monospacedDigit().foregroundStyle(.secondary)
            }
            ZStack(alignment: .top) {
                UnevenRoundedRectangle(topLeadingRadius: 12, topTrailingRadius: 12)
                    .fill(place == 1 ? AnyShapeStyle(game.theme.gradient) : AnyShapeStyle(Color(.tertiarySystemFill)))
                PlaceBadge(place: place).padding(.top, 8)
            }
            .frame(height: place == 1 ? 96 : place == 2 ? 72 : 52)
        }
        .frame(maxWidth: 110)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(player.map { "\(GameFormat.ordinal(place)): \($0.user.shownName), \(Int(($0.score ?? 0).rounded())) \(game.scoreUnit)" } ?? "\(GameFormat.ordinal(place)): nobody")
    }

    private func row(_ player: GameLobbyPlayer) -> some View {
        HStack(spacing: 10) {
            if let place = player.place { PlaceBadge(place: place, size: 24) } else {
                Text("DNF").font(.caption2.weight(.bold)).foregroundStyle(.secondary).frame(width: 24)
            }
            AvatarView(userId: player.user.id, size: 28)
            Text(player.user.shownName).font(.subheadline.weight(.medium)).lineLimit(1)
            Spacer()
            if let score = player.score {
                VStack(alignment: .trailing, spacing: 1) {
                    Text("\(Int(score.rounded())) \(game.scoreUnit)").font(.subheadline.weight(.bold)).monospacedDigit()
                    if game.raceStats, let accuracy = player.accuracy {
                        Text(String(format: "%.1f%% · %@", accuracy, GameFormat.duration(player.durationMs ?? 0)))
                            .font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                    }
                }
            } else {
                Text("Didn't finish").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(player.user.id == meId ? game.theme.from.opacity(0.14) : Color(.tertiarySystemFill).opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("results.player.\(player.user.id)")
    }
}

/// Finds people by name and invites them into the lobby (each gets a
/// `game_invite` notification; nothing is reserved for them).
struct InviteSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let lobby: GameLobby
    let meId: Int?
    @State private var query = ""
    @State private var results: [User] = []
    @State private var invited: Set<Int> = []
    @State private var searching = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error { ErrorBanner(message: error, identifier: "invite.error").listRowSeparator(.hidden) }
                if query.trimmingCharacters(in: .whitespaces).count < 3 {
                    Text("Type at least 3 characters to search.").foregroundStyle(.secondary)
                } else if searching && results.isEmpty {
                    ProgressView()
                } else if results.isEmpty {
                    Text("Nobody found.").foregroundStyle(.secondary).accessibilityIdentifier("invite.empty")
                }
                ForEach(results.filter { user in user.id != meId && !lobby.players.contains { $0.user.id == user.id } }, id: \.id) { user in
                    HStack(spacing: 10) {
                        AvatarView(userId: user.id, size: 32)
                        VStack(alignment: .leading) {
                            Text(user.shownName).font(.subheadline.weight(.medium))
                            Text("@\(user.username)").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if invited.contains(user.id) {
                            Label("Invited", systemImage: "checkmark").font(.caption.weight(.semibold)).foregroundStyle(.green)
                                .accessibilityIdentifier("invite.sent.\(user.id)")
                        } else {
                            Button("Invite") { Task { await invite(user) } }
                                .buttonStyle(.bordered)
                                .accessibilityIdentifier("invite.user.\(user.id)")
                        }
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search people")
            .navigationTitle("Invite players")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("invite.done") } }
            .task(id: query) { await search() }
        }
    }

    private func search() async {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 3 else { results = []; return }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        do {
            let found = try await env.games.searchUsers(trimmed)
            for user in found { env.users.store(user) }
            results = found
            error = nil
        } catch {
            let failure = APIError.from(error)
            if !failure.isCancelled { self.error = failure.message }
        }
    }

    private func invite(_ user: User) async {
        do {
            try await env.games.invite(user.id, to: lobby.id)
            invited.insert(user.id)
            error = nil
        } catch {
            self.error = APIError.from(error).message
        }
    }
}
