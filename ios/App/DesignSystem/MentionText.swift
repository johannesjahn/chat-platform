import SwiftUI

/// Post/comment/message text with `@mentions` that name a real account drawn
/// as links to that profile. Unresolved mentions stay plain text, exactly
/// like the web renderer.
struct MentionText: View {
    @Environment(AppEnvironment.self) private var env
    let text: String
    var identifier: String?
    @State private var resolved: [String: User] = [:]

    var body: some View {
        Text(attributed)
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == "chatplatform", url.host() == "user",
                      let id = Int(url.lastPathComponent)
                else { return .systemAction }
                env.router.push(.profile(id))
                return .handled
            })
            .task(id: text) {
                let names = Mentions.usernames(in: text)
                guard !names.isEmpty else { return }
                resolved = await env.users.resolve(usernames: names)
            }
            .accessibilityIdentifier(identifier ?? "mention.text")
    }

    private var attributed: AttributedString {
        var out = AttributedString()
        for segment in Mentions.parse(text) {
            switch segment {
            case .text(let plain):
                out += AttributedString(plain)
            case .mention(let shown, let username):
                var piece = AttributedString(shown)
                if let user = resolved[username.lowercased()] {
                    piece.link = URL(string: "chatplatform://user/\(user.id)")
                    piece.font = .body.weight(.semibold)
                }
                out += piece
            }
        }
        return out
    }
}
