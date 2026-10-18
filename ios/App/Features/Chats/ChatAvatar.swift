import ChatAPI
import SwiftUI

/// A chat's picture: the other person in a direct chat (with a presence dot),
/// the group's avatar, or a group glyph.
struct ChatAvatar: View {
    @Environment(AppEnvironment.self) private var env
    let chat: Chat
    var size: CGFloat = 48

    var body: some View {
        let me = env.auth.user?.id
        if chat.isGroup {
            Group {
                if let url = chat.avatarVariants?.small {
                    RemoteImage(urlString: url).frame(width: size, height: size).clipShape(Circle())
                } else {
                    Image(systemName: "person.3.fill")
                        .font(.system(size: size * 0.32, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: size, height: size)
                        .background(Color.accentColor.opacity(0.18), in: Circle())
                }
            }
            .accessibilityHidden(true)
        } else if let other = chat.other(than: me) {
            ParticipantAvatar(participant: other, size: size, showsPresence: true)
        }
    }
}

/// A participant's avatar, straight from the chat's participant record (so
/// it needs no profile fetch).
struct ParticipantAvatar: View {
    @Environment(AppEnvironment.self) private var env
    let participant: ChatParticipant
    var size: CGFloat = 32
    var showsPresence = false

    private static let palette: [Color] = [.blue, .indigo, .purple, .pink, .orange, .teal, .green, .red]

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let url = participant.avatarVariants?.small ?? participant.avatarUrl {
                    RemoteImage(urlString: url)
                } else {
                    ZStack {
                        Rectangle().fill(Self.palette[abs(participant.userId) % Self.palette.count].gradient)
                        Text(String(participant.shownName.first ?? "?").uppercased())
                            .font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(.white)
                    }
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            if showsPresence, env.users.isOnline(participant.userId) {
                Circle().fill(.green).frame(width: size * 0.28, height: size * 0.28)
                    .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
                    .accessibilityIdentifier("presence.\(participant.userId)")
            }
        }
        .accessibilityHidden(true)
    }
}
