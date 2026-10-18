import SwiftUI
import UIKit

/// A game's two signature colors (the web registry's `theme.from`/`theme.to`,
/// converted from oklch to sRGB) plus text tints that stay legible on the
/// app's backgrounds: a darker shade in light mode, a lighter one in dark
/// mode (each ≥ 6:1 against the system background). Text drawn *on* the
/// gradient is near-black — every pair keeps ≥ 5.5:1 against it, which white
/// wouldn't.
struct GameTheme: Sendable {
    let from: Color
    let to: Color
    let accentText: Color
    var onGradient: Color { Color(red: 0.07, green: 0.07, blue: 0.1) }
    var gradient: LinearGradient { LinearGradient(colors: [from, to], startPoint: .topLeading, endPoint: .bottomTrailing) }

    init(from: (Double, Double, Double), to: (Double, Double, Double), textLight: (Double, Double, Double), textDark: (Double, Double, Double)) {
        self.from = Color(red: from.0, green: from.1, blue: from.2)
        self.to = Color(red: to.0, green: to.1, blue: to.2)
        let light = UIColor(red: textLight.0, green: textLight.1, blue: textLight.2, alpha: 1)
        let dark = UIColor(red: textDark.0, green: textDark.1, blue: textDark.2, alpha: 1)
        accentText = Color(UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

/// Every game's look and copy, ported from `GAMES` in
/// web/src/lib/games/registry.ts. `slug` is nil for one that's announced but
/// not playable yet.
struct GameDefinition: Sendable, Identifiable {
    struct Step: Sendable {
        let systemImage: String
        let title: String
        let text: String
    }

    let id: String
    let slug: GameSlug?
    let name: String
    let tagline: String
    let description: String
    let systemImage: String
    let theme: GameTheme
    let players: String
    let scoreLabel: String
    let scoreUnit: String
    var steps: [Step] = []
    var startVerb = "Start"
    var startSoloVerb = "Start"
    var joinVerb = "Join"
    var accuracyLabel = "Acc"
    /// Whether accuracy and time are worth showing beside a result (they are
    /// for a race; a party game's score says it all).
    var raceStats = false

    var isPlayable: Bool { slug != nil }

    static let all: [GameDefinition] = [
        GameDefinition(
            id: "typing", slug: .typing, name: "Type Race", tagline: "Fastest fingers win",
            description: "Race up to five friends to type a passage first. Watch every opponent's lane move live, then climb the leaderboard.",
            systemImage: "keyboard",
            theme: GameTheme(from: (0.000, 0.761, 0.809), to: (0.650, 0.353, 1.000), textLight: (0.000, 0.411, 0.613), textDark: (0.312, 0.851, 0.937)),
            players: "1–6 players", scoreLabel: "Words per minute", scoreUnit: "WPM",
            steps: [
                Step(systemImage: "person.3", title: "Gather", text: "Quick play drops you into the fullest open lobby — or open your own and invite friends."),
                Step(systemImage: "bolt", title: "Race", text: "The host starts a countdown. Everyone gets the same passage; every lane moves live."),
                Step(systemImage: "trophy", title: "Climb", text: "Every finish counts toward the leaderboard. Speed ranks you; wins need an opponent."),
            ],
            startVerb: "Start race", startSoloVerb: "Start solo race", joinVerb: "Join the race",
            accuracyLabel: "Acc", raceStats: true
        ),
        GameDefinition(
            id: "drawing", slug: .drawing, name: "Sketchy", tagline: "Draw badly, lie brilliantly",
            description: "Everyone draws a secret prompt, then invents fake titles for each other's doodles. Find the truth, fool your friends.",
            systemImage: "paintbrush.pointed",
            theme: GameTheme(from: (1.000, 0.441, 0.735), to: (1.000, 0.656, 0.276), textLight: (0.669, 0.112, 0.447), textDark: (1.000, 0.628, 0.815)),
            players: "3–8 players", scoreLabel: "Points", scoreUnit: "pts",
            steps: [
                Step(systemImage: "pencil.line", title: "Draw", text: "Everyone gets a different secret prompt from the host's theme packs — and 75 seconds to draw it."),
                Step(systemImage: "theatermasks", title: "Bluff", text: "Each drawing takes a turn in the spotlight. Invent a title others will believe is the real one."),
                Step(systemImage: "checkmark.seal", title: "Vote", text: "Find the truth for 1000 points, earn 500 for everyone you fooled, then watch the reveal."),
            ],
            startVerb: "Start game", startSoloVerb: "Start game", joinVerb: "Join the game",
            accuracyLabel: "Guess", raceStats: false
        ),
        GameDefinition(
            id: "reflex", slug: .reflex, name: "Reflex Rush", tagline: "Blink and you lose",
            description: "Eight rounds of pure nerve: wait for green, dodge the decoys, snap the symbol, hit the target. Solo or head to head, milliseconds decide it.",
            systemImage: "bolt.fill",
            theme: GameTheme(from: (0.348, 0.870, 0.396), to: (0.000, 0.738, 0.707), textLight: (0.000, 0.447, 0.231), textDark: (0.437, 0.926, 0.566)),
            players: "1–6 players", scoreLabel: "Points", scoreUnit: "pts",
            steps: [
                Step(systemImage: "timer", title: "Wait for it", text: "Every round hides its signal behind a random wait. Everyone in the lobby gets it at the same instant."),
                Step(systemImage: "eye.slash", title: "Don't flinch", text: "Decoys, wrong symbols, arrows and targets. Jump early and it costs you — fast and clean builds a combo."),
                Step(systemImage: "trophy", title: "Climb", text: "Play solo for a personal best or duel up to five friends. Every run lands on the leaderboard."),
            ],
            startVerb: "Start the duel", startSoloVerb: "Play solo", joinVerb: "Join the duel",
            accuracyLabel: "Clean", raceStats: false
        ),
        GameDefinition(
            id: "trivia", slug: nil, name: "Trivia Blitz", tagline: "Know it, buzz it",
            description: "Rapid-fire questions, one buzzer, no second chances. Coming to the arcade soon.",
            systemImage: "brain",
            theme: GameTheme(from: (0.928, 0.706, 0.092), to: (1.000, 0.309, 0.231), textLight: (0.601, 0.291, 0.000), textDark: (0.984, 0.789, 0.348)),
            players: "2–8 players", scoreLabel: "Points", scoreUnit: "pts"
        ),
    ]

    static func playable(_ slug: GameSlug) -> GameDefinition {
        all.first { $0.slug == slug }!
    }

    /// The game for an unvalidated slug (a route, a notification), if it's playable.
    static func playable(slug raw: String) -> GameDefinition? {
        guard let slug = GameSlug(rawValue: raw) else { return nil }
        return all.first { $0.slug == slug }
    }
}
