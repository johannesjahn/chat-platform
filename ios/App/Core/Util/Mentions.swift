import Foundation

/// `@username` mentions, parsed exactly like the web renderer and the server
/// (web/src/lib/mentions.ts, the regex in src/notifications.ts): only a
/// mention a reader sees as a link may notify, so these must stay in step.
enum Mentions {
    /// Characters a mention token may contain. "-" is last so it's literal.
    static let maxUsernameLength = 32
    /// The server rejects a lookup naming more distinct users than this.
    static let maxLookupCount = 32

    enum Segment: Equatable, Sendable {
        case text(String)
        case mention(text: String, username: String)
    }

    // Swift's own Regex has no lookbehind; ICU's does.
    private static let regex = try! NSRegularExpression(pattern: "(?<![A-Za-z0-9_.-])@([A-Za-z0-9_.-]{1,32})")

    /// Splits `text` into plain runs and mentions; every segment is a verbatim
    /// slice, so concatenating them reproduces the input.
    static func parse(_ text: String) -> [Segment] {
        let ns = text as NSString
        var segments: [Segment] = []
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            var username = ns.substring(with: match.range(at: 1))
            // A trailing "." or "-" is almost always sentence punctuation.
            while let last = username.last, last == "." || last == "-" { username.removeLast() }
            guard !username.isEmpty else { continue }
            let start = match.range.location
            let length = 1 + (username as NSString).length
            if start > cursor { segments.append(.text(ns.substring(with: NSRange(location: cursor, length: start - cursor)))) }
            segments.append(.mention(text: ns.substring(with: NSRange(location: start, length: length)), username: username))
            cursor = start + length
        }
        if cursor < ns.length { segments.append(.text(ns.substring(from: cursor))) }
        return segments
    }

    /// Distinct mentioned usernames, in order, capped at the lookup limit.
    static func usernames(in text: String) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for case .mention(_, let username) in parse(text) where seen.insert(username.lowercased()).inserted {
            out.append(username)
            if out.count == maxLookupCount { break }
        }
        return out
    }
}
