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
                out += Self.linkified(plain)
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

    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Plain text with any web links made tappable, like the web renderer.
    static func linkified(_ plain: String) -> AttributedString {
        var piece = AttributedString(plain)
        guard let detector = linkDetector else { return piece }
        let range = NSRange(plain.startIndex..., in: plain)
        for match in detector.matches(in: plain, range: range) {
            guard let url = match.url, url.scheme == "http" || url.scheme == "https",
                  let stringRange = Range(match.range, in: plain),
                  let lower = AttributedString.Index(stringRange.lowerBound, within: piece),
                  let upper = AttributedString.Index(stringRange.upperBound, within: piece)
            else { continue }
            piece[lower..<upper].link = url
            piece[lower..<upper].underlineStyle = .single
        }
        return piece
    }
}
