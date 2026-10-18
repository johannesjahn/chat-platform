import Foundation

/// Reflex Rush's client side, ported from web/src/lib/games/reflex.ts. The
/// schedule (`ReflexRound`s) comes from the server, expanded from a secret
/// seed; this follows it on the server-corrected clock and judges presses
/// only to show a verdict straight away. The *server* scores the game from
/// the taps submitted at the end — the constants below mirror
/// src/games/reflex.ts for that instant feedback and must track it (a unit
/// test compares them with the server source).
enum Reflex {
    static let anticipationMs: Double = 100
    static let falseStartPenalty = 200
    static let maxRoundPoints = 1000
    static let minRoundPoints = 100
    static let pointsPerMs: Double = 2
    static let comboStep = 0.1
    static let maxComboSteps = 5
    static let arenaAspect: Double = 16.0 / 10.0
    static let targetRadius = 0.07
    static let decoyFlashMs: Double = 450
    /// How long the final round's result shows before the arena says "done".
    static let finalResultMs: Double = 1600
    static let parMs: [ReflexKind: Double] = [.go: 150, .decoy: 150, .match: 200, .arrow: 250, .target: 350]

    /// A match round's symbols by the index the server deals — exactly
    /// REFLEX_SYMBOLS long and never reordered (web's `REFLEX_SYMBOLS`).
    static let symbols = ["🍉", "⭐", "🍄", "💎", "🔔", "🐸"]
    /// A decoy flash's look by `variant` (web's `REFLEX_DECOYS`).
    static let decoys = ["READY?", "HOLD", "GO!"]

    static func copy(_ kind: ReflexKind) -> (title: String, instruction: String, systemImage: String) {
        switch kind {
        case .go: ("Quick draw", "Hit it the instant it turns green", "bolt.fill")
        case .decoy: ("Decoys", "Only green counts — don't fall for the fakes", "eye.slash")
        case .match: ("Snap", "Hit only when your symbol shows up", "square.grid.2x2")
        case .arrow: ("Arrows", "Tap the side the arrow points to", "arrow.up.and.down.and.arrow.left.and.right")
        case .target: ("Bullseye", "Tap the target the moment it appears", "scope")
        }
    }

    static func basePoints(_ kind: ReflexKind, reactionMs: Double) -> Int {
        let raw = (Double(maxRoundPoints) - pointsPerMs * (reactionMs - (parMs[kind] ?? 150))).rounded(.toNearestOrAwayFromZero)
        return max(minRoundPoints, min(maxRoundPoints, Int(raw)))
    }

    static func comboMultiplier(_ streak: Int) -> Double { 1 + comboStep * Double(min(streak, maxComboSteps)) }

    // MARK: live results over the socket

    /// One round's verdict as everyone sees it live.
    struct LiveResult: Sendable, Equatable {
        var outcome: ReflexOutcome
        var reactionMs: Double?
    }

    private static let earlyCode = 990
    private static let missCode = 991
    private static let wrongCode = 992

    /// Packs a round's result into one `game_progress` number:
    /// `(round + 1) * 1000 + code`, the code a hit's time at 2ms resolution or
    /// one of the misses — the round keeps the number growing (progress only
    /// ever moves forward), and eight rounds stay under the server's 10 000.
    static func encodeLiveResult(index: Int, _ result: LiveResult) -> Int {
        let code: Int
        switch result.outcome {
        case .hit: code = min(Int(((result.reactionMs ?? 0) / 2).rounded(.toNearestOrAwayFromZero)), earlyCode - 1)
        case .early: code = earlyCode
        case .wrong: code = wrongCode
        case .miss: code = missCode
        }
        return (index + 1) * 1000 + code
    }

    static func decodeLiveResult(_ progress: Int) -> (index: Int, result: LiveResult)? {
        let index = progress / 1000 - 1
        guard index >= 0 else { return nil }
        let code = progress % 1000
        switch code {
        case earlyCode: return (index, LiveResult(outcome: .early, reactionMs: nil))
        case missCode: return (index, LiveResult(outcome: .miss, reactionMs: nil))
        case wrongCode: return (index, LiveResult(outcome: .wrong, reactionMs: nil))
        default: return (index, LiveResult(outcome: .hit, reactionMs: Double(code * 2)))
        }
    }

    /// Points per round and the total for a run of results, the way the
    /// server scores them — for live standings before its word is in. Holes
    /// (rounds not played yet) score nothing and don't break a streak.
    static func score(_ rounds: [ReflexRound], _ results: [LiveResult?]) -> (points: [Int?], total: Int) {
        var streak = 0
        let points: [Int?] = rounds.indices.map { index in
            guard index < results.count, let result = results[index] else { return nil }
            guard result.outcome == .hit, let ms = result.reactionMs else {
                streak = 0
                return result.outcome == .early ? -falseStartPenalty : 0
            }
            let earned = Int((Double(basePoints(rounds[index].kind, reactionMs: ms)) * comboMultiplier(streak)).rounded(.toNearestOrAwayFromZero))
            streak += 1
            return earned
        }
        return (points, max(0, points.reduce(0) { $0 + ($1 ?? 0) }))
    }

    /// Clean hits in a row going into round `index`.
    static func streak(before index: Int, in results: [LiveResult?]) -> Int {
        var streak = 0
        var cursor = index - 1
        while cursor >= 0, cursor < results.count, results[cursor]?.outcome == .hit {
            streak += 1
            cursor -= 1
        }
        return streak
    }

    // MARK: where the game is

    enum Stage: String, Sendable, Equatable {
        /// Before the first round (the lobby countdown).
        case before
        /// The round's title card; presses are ignored.
        case intro
        /// Armed: any press is a false start.
        case wait
        /// The signal is up.
        case signal
        /// The window closed; the round's result is showing.
        case result
        /// The last round is over.
        case done
    }

    struct ViewState: Sendable, Equatable {
        var index: Int
        var stage: Stage
        /// The decoy flash or wrong symbol on screen, as an index into the
        /// round's cues.
        var cue: Int?
    }

    static func view(_ rounds: [ReflexRound], introMs: Double, now: Double) -> ViewState {
        guard let index = rounds.lastIndex(where: { now >= Double($0.armAt) }) else {
            return ViewState(index: 0, stage: .before, cue: nil)
        }
        let round = rounds[index]
        if now < Double(round.armAt) + introMs { return ViewState(index: index, stage: .intro, cue: nil) }
        if now < Double(round.signalAt) {
            var cue: Int?
            if let last = round.cues.lastIndex(where: { now >= $0.at }) {
                // A decoy is a flash; a wrong symbol stays up until the next.
                if round.kind == .match || now < round.cues[last].at + decoyFlashMs { cue = last }
            }
            return ViewState(index: index, stage: .wait, cue: cue)
        }
        if now < Double(round.closeAt) { return ViewState(index: index, stage: .signal, cue: nil) }
        if index == rounds.count - 1, now >= Double(round.closeAt) + finalResultMs {
            return ViewState(index: index, stage: .done, cue: nil)
        }
        return ViewState(index: index, stage: .result, cue: nil)
    }

    /// On a touch screen an Arrows round is answered by tapping the side of
    /// the arena the arrow points to — split along its diagonals.
    static func direction(atX x: Double, y: Double) -> ReflexDirection {
        let dx = (x - 0.5) * arenaAspect
        let dy = y - 0.5
        if abs(dx) > abs(dy) { return dx < 0 ? .left : .right }
        return dy < 0 ? .up : .down
    }

    static func isOnTarget(_ round: ReflexRound, x: Double, y: Double) -> Bool {
        guard let target = round.target else { return false }
        let dx = x - target.x
        let dy = (y - target.y) / arenaAspect
        return (dx * dx + dy * dy).squareRoot() <= targetRadius
    }

    static let noTap = ReflexTap(early: false, reactionMs: nil, direction: nil, x: nil, y: nil)

    /// Judges a press during the signal, the way the server will: too fast
    /// to be a reaction is a false start, an arrow must match. (A target
    /// press off the target isn't a verdict at all — it's a whiff, and the
    /// round stays open.)
    static func judge(_ round: ReflexRound, reactionMs: Double, direction: ReflexDirection?, x: Double?, y: Double?) -> (result: LiveResult, tap: ReflexTap) {
        let ms = max(0, reactionMs.rounded(.toNearestOrAwayFromZero))
        if ms < anticipationMs {
            return (LiveResult(outcome: .early, reactionMs: nil), ReflexTap(early: true, reactionMs: nil, direction: nil, x: nil, y: nil))
        }
        let tap = ReflexTap(
            early: false, reactionMs: Int(ms), direction: direction,
            x: round.kind == .target ? x : nil, y: round.kind == .target ? y : nil
        )
        let outcome: ReflexOutcome = round.kind == .arrow && direction != round.direction ? .wrong : .hit
        return (LiveResult(outcome: outcome, reactionMs: ms), tap)
    }

    /// A reaction time, in words.
    static func rating(_ ms: Double) -> String {
        switch ms {
        case ..<180: "Inhuman"
        case ..<230: "Lightning"
        case ..<280: "Blazing"
        case ..<340: "Sharp"
        case ..<450: "Solid"
        default: "Sleepy"
        }
    }
}
