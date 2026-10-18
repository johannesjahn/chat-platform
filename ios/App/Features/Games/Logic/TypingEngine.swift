import Foundation

/// The typing race's engine for one round, a port of `useTypingRace`
/// (web/src/lib/games/typing.ts): owns what's been typed, counts wrong
/// keystrokes as they happen (they can't be undone — fixing one still costs
/// accuracy), and knows the race position (the correctly typed prefix). The
/// server re-checks the finished text and times the finish itself; nothing
/// here is a score.
struct TypingEngine: Sendable, Equatable {
    /// How far past a mistake the racer may keep typing before input stops
    /// registering — enough to notice the red, not enough to type a whole
    /// wrong sentence.
    static let maxErrorRun = 6
    /// Before this much of the race has elapsed a live WPM is mostly noise.
    static let minWpmSampleMs: Double = 1000

    let passage: [Character]
    private(set) var typed: [Character] = []
    private(set) var errors = 0
    private(set) var correct = 0
    private(set) var done = false

    init(passage: String) { self.passage = Array(passage) }

    var typedText: String { String(typed) }

    /// Applies the field's new contents. Returns the text the field should
    /// show (line breaks dropped, a runaway mistake capped).
    @discardableResult
    mutating func input(_ next: String) -> String {
        guard !done else { return typedText }
        var value = Array(next.filter { $0 != "\n" && $0 != "\r" })
        let limit = min(passage.count, Self.correctPrefixLength(passage, value) + Self.maxErrorRun)
        if value.count > limit { value = Array(value.prefix(limit)) }
        if value.count > typed.count {
            for index in typed.count..<value.count where value[index] != passage[index] { errors += 1 }
        }
        typed = value
        correct = Self.correctPrefixLength(passage, value)
        done = value == passage
        return typedText
    }

    /// Whether the racer just completed a word — a progress frame goes out
    /// straight away then.
    var atWordBoundary: Bool { correct > 0 && passage[correct - 1] == " " }

    var accuracy: Double {
        typed.isEmpty ? 100 : Double(correct) / Double(correct + errors) * 100
    }

    var progress: Double { passage.isEmpty ? 0 : Double(min(correct, passage.count)) / Double(passage.count) }

    static func correctPrefixLength(_ passage: [Character], _ typed: [Character]) -> Int {
        let count = min(passage.count, typed.count)
        var index = 0
        while index < count, passage[index] == typed[index] { index += 1 }
        return index
    }

    /// Standard WPM: five characters (spaces included) is one word.
    static func wordsPerMinute(chars: Int, elapsedMs: Double) -> Double {
        elapsedMs < minWpmSampleMs ? 0 : Double(chars) / 5 / (elapsedMs / 60_000)
    }
}
