import SwiftUI

/// Renders a server snippet: its runs in order, the matched ones marked.
/// The text is only ever plain characters in an `AttributedString` (never
/// parsed as markup), the iOS twin of web/src/components/SearchHighlight.tsx.
enum SearchHighlight {
    static func attributed(_ segments: [SnippetSegment]) -> AttributedString {
        var out = AttributedString()
        for segment in segments {
            var run = AttributedString(segment.text)
            if segment.match {
                run.inlinePresentationIntent = .stronglyEmphasized
                run.backgroundColor = Color.accentColor.opacity(0.28)
            }
            out += run
        }
        return out
    }

    /// The matched fragments, for VoiceOver (a highlight it can't see) and
    /// for the UI tests.
    static func matches(_ segments: [SnippetSegment]) -> [String] {
        segments.filter(\.match).map(\.text)
    }
}

/// A snippet as a `Text`, with its matches exposed as the accessibility value.
struct SnippetText: View {
    let segments: [SnippetSegment]
    var lineLimit: Int? = 3
    var identifier: String

    var body: some View {
        let matches = SearchHighlight.matches(segments)
        Text(SearchHighlight.attributed(segments))
            .lineLimit(lineLimit)
            .accessibilityValue(matches.isEmpty ? "" : "Matched: \(matches.joined(separator: ", "))")
            .accessibilityIdentifier(identifier)
    }
}
