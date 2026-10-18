import SwiftUI

/// The lobby's chat and reaction bar, shared by every game and shown in every
/// phase. When the server reports the chat closed (Sketchy mid-game — see
/// `chatOpen`), the history folds away and only the reactions stay.
struct LobbyChatPanel: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition
    let meId: Int
    @State private var draft = ""
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    static let maxLength = 280

    var body: some View {
        GamePanel(title: "Lobby chat", systemImage: "bubble.left.and.bubble.right", identifier: "lobby.chat") {
            LobbyReactionBar(lobby: lobby, meId: meId)
            if lobby.chatOpen {
                let messages = env.games.chats[lobby.id] ?? []
                VStack(alignment: .leading, spacing: 10) {
                    if messages.isEmpty {
                        Text("No messages yet — say hi to the lobby 👋").font(.footnote).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).accessibilityIdentifier("lobby.chat.empty")
                    }
                    ForEach(messages.suffix(50), id: \.id) { message in row(message) }
                }
                HStack(spacing: 8) {
                    TextField("Message the lobby…", text: $draft)
                        .focused($focused)
                        .submitLabel(.send)
                        .onSubmit { Task { await send() } }
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                        .accessibilityIdentifier("lobby.chat.field")
                    Button { Task { await send() } } label: {
                        Image(systemName: "arrow.up").font(.body.weight(.bold)).frame(width: 36, height: 36)
                    }
                    .buttonStyle(GameIconButtonStyle(theme: game.theme))
                    .disabled(trimmed.isEmpty || sending || trimmed.count > Self.maxLength)
                    .accessibilityLabel("Send")
                    .accessibilityIdentifier("lobby.chat.send")
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red).accessibilityIdentifier("lobby.chat.error") }
            } else {
                Label("Chat is paused while the game is on — no spoilers. Cheer with reactions instead!", systemImage: "lock.fill")
                    .font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("lobby.chat.closed")
            }
        }
        .task(id: ChatKey(lobby: lobby.id, token: env.invalidations.token(.games), open: lobby.chatOpen)) {
            guard lobby.chatOpen else { return }
            try? await env.games.loadChat(lobby.id)
        }
    }

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func row(_ message: GameChatMessage) -> some View {
        let mine = message.user.id == meId
        let seated = lobby.players.contains { $0.user.id == message.user.id }
        return HStack(alignment: .top, spacing: 8) {
            AvatarView(userId: message.user.id, size: 26)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(mine ? "You" : message.user.shownName).font(.caption.weight(.semibold))
                        .foregroundStyle(mine ? game.theme.accentText : .secondary)
                    if message.user.id == lobby.hostId { Text("· host").font(.caption).foregroundStyle(.secondary) }
                    if !seated { Text("· watching").font(.caption).foregroundStyle(.secondary) }
                }
                Text(message.text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("lobby.chat.message.\(message.id)")
    }

    private func send() async {
        let text = trimmed
        guard !text.isEmpty, !sending else { return }
        sending = true
        defer { sending = false }
        do {
            try await env.games.postChat(lobby.id, text: text)
            draft = ""
            error = nil
        } catch {
            self.error = APIError.from(error).message
        }
    }
}

private struct ChatKey: Hashable {
    var lobby: Int
    var token: Int
    var open: Bool
}

struct GameIconButtonStyle: ButtonStyle {
    let theme: GameTheme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? theme.onGradient : Color.secondary)
            .background {
                if isEnabled { Circle().fill(theme.gradient).opacity(configuration.isPressed ? 0.8 : 1) }
                else { Circle().fill(Color(.tertiarySystemFill)) }
            }
            .contentShape(Circle())
    }
}

/// The fixed emoji set, flung to everyone in the lobby (relayed by the
/// server, never stored — players and spectators alike).
struct LobbyReactionBar: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let meId: Int

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(GameStore.reactions, id: \.self) { emoji in
                    Button { env.games.fling(emoji, in: lobby.id, me: meId) } label: {
                        Text(emoji).font(.title3).frame(width: 40, height: 40)
                            .background(Color(.tertiarySystemFill), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("React \(emoji)")
                    .accessibilityIdentifier("lobby.react.\(emoji)")
                }
            }
        }
        .scrollClipDisabled()
    }
}

/// Everyone's flung emoji floating up over the lobby. With Reduce Motion
/// they fade in place instead of flying.
struct ReactionStream: View {
    @Environment(AppEnvironment.self) private var env
    let lobbyId: Int

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                ForEach(env.games.flying.filter { $0.lobbyId == lobbyId }) { reaction in
                    FlyingEmoji(reaction: reaction, size: proxy.size, name: env.users.user(reaction.userId)?.shownName ?? "Someone")
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .allowsHitTesting(false)
    }
}

private struct FlyingEmoji: View {
    let reaction: GameStore.FlyingReaction
    let size: CGSize
    let name: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var launched = false

    var body: some View {
        Text(reaction.reaction)
            .font(.system(size: 38))
            .position(
                x: size.width * reaction.x + (launched && !reduceMotion ? reaction.drift * 40 : 0),
                y: launched && !reduceMotion ? size.height * 0.15 : size.height * 0.85
            )
            .opacity(launched ? 0 : 1)
            .onAppear {
                withAnimation(.easeOut(duration: GameStore.reactionFlightSeconds)) { launched = true }
            }
            .accessibilityElement()
            .accessibilityLabel("\(name) reacted \(reaction.reaction)")
            .accessibilityIdentifier("lobby.reaction.flying")
            .accessibilityValue(reaction.reaction)
    }
}
