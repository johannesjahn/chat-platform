import SwiftUI
import UIKit

/// Reflex Rush's play area: the round track, the player's own score line,
/// the arena everyone watches, and the duel board — every player's rounds
/// filling in live from their `game_progress` frames, then the server's
/// scored breakdown once it's in.
struct ReflexPlayView: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition
    let meId: Int?
    let now: Double

    @State private var engine: ReflexEngine?
    @State private var submitting = false
    @State private var submitError: String?

    private var reflex: ReflexGame? { lobby.reflex }
    private var rounds: [ReflexRound] { reflex?.rounds ?? [] }
    private var me: GameLobbyPlayer? { lobby.player(meId) }
    private var submitted: Bool { me?.durationMs != nil }
    private var runKey: String { "\(lobby.id):\(lobby.round)" }

    var body: some View {
        VStack(spacing: 16) {
            GamePanel(identifier: "reflex.panel") {
                if let engine {
                    RoundTrack(rounds: rounds, results: engine.results, view: engine.view)
                    if me != nil { hud(engine) }
                    ReflexArena(engine: engine, theme: game.theme, interactive: me != nil && !submitted)
                        .overlay {
                            CountdownOverlay(startsAt: lobby.startsAt, now: now,
                                             hint: me != nil ? "Hands ready — tap the arena on the signal" : "You're spectating — enjoy the show",
                                             theme: game.theme)
                        }
                    if submitting { ProgressView("Sending your run…").font(.footnote).frame(maxWidth: .infinity) }
                    if submitted {
                        Label("Run submitted — waiting for the others", systemImage: "checkmark.circle.fill")
                            .font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                            .accessibilityIdentifier("reflex.submitted")
                    }
                    if let submitError {
                        HStack {
                            Text(submitError).font(.footnote).foregroundStyle(.red)
                            Button("Send again") { Task { await submit(engine.allTaps) } }.font(.footnote.weight(.semibold))
                        }
                        .accessibilityIdentifier("reflex.error")
                    }
                }
            }
            DuelBoard(lobby: lobby, game: game, meId: meId, ownResults: engine?.results ?? [], currentIndex: engine?.view.index ?? 0)
        }
        .onAppear(perform: setUp)
        .onDisappear { engine?.stop() }
        .onChange(of: submitted) { _, done in engine?.enabled = me != nil && !done }
    }

    private func setUp() {
        if let engine {
            engine.start()
            return
        }
        guard let reflex else { return }
        let store = env.games
        let key = runKey
        let lobbyId = lobby.id
        let meId = meId
        let made = ReflexEngine(
            rounds: reflex.rounds, introMs: reflex.introMs, enabled: me != nil && !submitted,
            results: store.reflexResults[key], taps: store.reflexTaps[key],
            serverNow: { [weak store] in store?.serverNow() ?? localNowMs() }
        )
        made.onRecord = { [weak store] index, result, results, taps in
            store?.reflexResults[key] = results
            store?.reflexTaps[key] = taps
            store?.sendProgress(lobbyId, Reflex.encodeLiveResult(index: index, result), me: meId)
        }
        made.onComplete = { taps in Task { await submit(taps) } }
        engine = made
        made.start()
    }

    private func submit(_ taps: [ReflexTap]) async {
        submitting = true
        defer { submitting = false }
        do {
            try await env.games.finishReflex(lobby.id, taps: taps)
            submitError = nil
        } catch {
            submitError = APIError.from(error).message
        }
    }

    private func hud(_ engine: ReflexEngine) -> some View {
        let total = Reflex.score(rounds, engine.results).total
        let streak = Reflex.streak(before: engine.results.firstIndex(where: { $0 == nil }) ?? engine.results.count, in: engine.results)
        let best = engine.results.compactMap { $0?.outcome == .hit ? $0?.reactionMs : nil }.min()
        return HStack(spacing: 8) {
            StatTile(label: "Score", value: "\(total)", emphasis: game.theme.accentText, identifier: "reflex.score")
            StatTile(label: "Combo", value: String(format: "×%.1f", Reflex.comboMultiplier(streak)))
            StatTile(label: "Best", value: best.map { "\(Int($0))ms" } ?? "—")
        }
    }
}

/// The rounds as a strip of tiles: each kind's glyph, tinted with how it went.
private struct RoundTrack: View {
    let rounds: [ReflexRound]
    let results: [Reflex.LiveResult?]
    let view: Reflex.ViewState

    var body: some View {
        HStack(spacing: 5) {
            ForEach(Array(rounds.enumerated()), id: \.offset) { index, round in
                let result = index < results.count ? results[index] : nil
                let current = index == view.index && view.stage != .before && view.stage != .done
                Image(systemName: Reflex.copy(round.kind).systemImage)
                    .font(.caption2.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 28)
                    .foregroundStyle(OutcomeStyle.foreground(result?.outcome) ?? (current ? .primary : .secondary))
                    .background(OutcomeStyle.background(result?.outcome), in: RoundedRectangle(cornerRadius: 7))
                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(current ? Color.primary : .clear, lineWidth: 1.5))
                    .accessibilityLabel("Round \(index + 1), \(Reflex.copy(round.kind).title)\(result.map { ", \($0.outcome.rawValue)" } ?? "")")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("reflex.rounds")
    }
}

enum OutcomeStyle {
    static func foreground(_ outcome: ReflexOutcome?) -> Color? {
        switch outcome {
        case .hit: Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.45, green: 0.9, blue: 0.55, alpha: 1) : UIColor(red: 0.05, green: 0.45, blue: 0.2, alpha: 1) })
        case .early: Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 1, green: 0.55, blue: 0.5, alpha: 1) : UIColor(red: 0.7, green: 0.12, blue: 0.1, alpha: 1) })
        case .miss, .wrong: .secondary
        case nil: nil
        }
    }

    static func background(_ outcome: ReflexOutcome?) -> Color {
        switch outcome {
        case .hit: Color.green.opacity(0.22)
        case .early: Color.red.opacity(0.2)
        case .miss, .wrong: Color(.tertiarySystemFill)
        case nil: Color(.tertiarySystemFill).opacity(0.5)
        }
    }

    static func label(_ result: Reflex.LiveResult?) -> String {
        guard let result else { return "·" }
        switch result.outcome {
        case .hit: return "\(Int(result.reactionMs ?? 0))"
        case .early: return "Early"
        case .miss: return "Miss"
        case .wrong: return "Wrong"
        }
    }
}

/// The arena: what the current round shows, on the schedule's clock, with a
/// touch layer that records each press's own timestamp and position.
private struct ReflexArena: View {
    let engine: ReflexEngine
    let theme: GameTheme
    let interactive: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let view = engine.view
        let round = engine.rounds.indices.contains(view.index) ? engine.rounds[view.index] : nil
        let result = view.index < engine.results.count ? engine.results[view.index] : nil
        GeometryReader { proxy in
            ZStack {
                RoundedRectangle(cornerRadius: 18).fill(background(view: view, round: round))
                content(view: view, round: round, result: result, size: proxy.size)
                ForEach(engine.whiffs) { whiff in
                    Circle().stroke(Color.secondary, lineWidth: 2).frame(width: 26, height: 26)
                        .position(x: whiff.x * proxy.size.width, y: whiff.y * proxy.size.height)
                }
                if let round, round.kind == .arrow, interactive, view.stage == .wait || view.stage == .signal {
                    arrowZones
                }
                ArenaTouchLayer { at, point in
                    engine.press(at: at, x: point.x / max(proxy.size.width, 1), y: point.y / max(proxy.size.height, 1))
                }
                .allowsHitTesting(interactive)
            }
        }
        .aspectRatio(Reflex.arenaAspect, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(view: view, round: round, result: result))
        .accessibilityValue(view.stage.rawValue)
        .accessibilityAddTraits(interactive ? [.allowsDirectInteraction, .updatesFrequently] : .updatesFrequently)
        .accessibilityAction(named: "Tap") { engine.press(at: CACurrentMediaTime(), x: round?.target?.x ?? 0.5, y: round?.target?.y ?? 0.5) }
        .accessibilityIdentifier("reflex.arena")
    }

    private func background(view: Reflex.ViewState, round: ReflexRound?) -> Color {
        switch view.stage {
        case .signal where round?.kind == .go || round?.kind == .decoy: Color(red: 0.13, green: 0.72, blue: 0.33)
        case .wait where round?.kind == .decoy && view.cue != nil: decoyColor(round: round, cue: view.cue)
        case .wait: Color(red: 0.75, green: 0.16, blue: 0.2)
        default: Color(white: 0.14)
        }
    }

    private func decoyColor(round: ReflexRound?, cue: Int?) -> Color {
        guard let round, let cue, round.cues.indices.contains(cue) else { return Color(white: 0.14) }
        switch Int(round.cues[cue].variant) {
        case 0: return Color(red: 0.85, green: 0.6, blue: 0.1)
        case 1: return Color(red: 0.15, green: 0.4, blue: 0.85)
        default: return Color(red: 0.9, green: 0.25, blue: 0.15)
        }
    }

    @ViewBuilder
    private func content(view: Reflex.ViewState, round: ReflexRound?, result: Reflex.LiveResult?, size: CGSize) -> some View {
        let white = Color.white
        switch view.stage {
        case .before:
            Text("Get ready").font(.title2.weight(.bold)).foregroundStyle(white)
        case .intro:
            if let round {
                VStack(spacing: 6) {
                    Text("Round \(view.index + 1)").font(.caption.weight(.bold)).foregroundStyle(white.opacity(0.75))
                    Label(Reflex.copy(round.kind).title, systemImage: Reflex.copy(round.kind).systemImage)
                        .font(.title2.weight(.heavy)).foregroundStyle(white)
                    Text(Reflex.copy(round.kind).instruction).font(.subheadline).foregroundStyle(white.opacity(0.85))
                        .multilineTextAlignment(.center)
                    if round.kind == .match, let symbol = round.symbol {
                        Text("Your symbol: \(Reflex.symbols[Int(symbol) % Reflex.symbols.count])").font(.headline).foregroundStyle(white)
                    }
                }
                .padding()
            }
        case .wait:
            VStack(spacing: 6) {
                if let round, round.kind == .match, let cue = view.cue, round.cues.indices.contains(cue) {
                    Text(Reflex.symbols[Int(round.cues[cue].variant) % Reflex.symbols.count]).font(.system(size: 64))
                } else if let round, round.kind == .decoy, let cue = view.cue, round.cues.indices.contains(cue) {
                    Text(Reflex.decoys[Int(round.cues[cue].variant) % Reflex.decoys.count]).font(.system(size: 40, weight: .black)).foregroundStyle(white)
                } else {
                    Text(round?.kind == .target ? "Aim…" : "Wait…").font(.system(size: 40, weight: .black)).foregroundStyle(white)
                }
                if let round, round.kind == .match, let symbol = round.symbol {
                    Text("Hit on \(Reflex.symbols[Int(symbol) % Reflex.symbols.count])").font(.footnote.weight(.semibold)).foregroundStyle(white.opacity(0.8))
                }
            }
        case .signal:
            if let round {
                switch round.kind {
                case .go, .decoy:
                    Text("TAP!").font(.system(size: 56, weight: .black)).foregroundStyle(white)
                case .match:
                    Text(Reflex.symbols[Int(round.symbol ?? 0) % Reflex.symbols.count]).font(.system(size: 72))
                case .arrow:
                    Image(systemName: arrowSymbol(round.direction)).font(.system(size: 72, weight: .black)).foregroundStyle(white)
                case .target:
                    if let target = round.target {
                        let diameter = Reflex.targetRadius * 2 * size.width
                        ZStack {
                            Circle().fill(Color.red)
                            Circle().fill(Color.white).padding(diameter * 0.18)
                            Circle().fill(Color.red).padding(diameter * 0.34)
                        }
                        .frame(width: diameter, height: diameter)
                        .position(x: target.x * size.width, y: target.y * size.height)
                    }
                }
            }
        case .result, .done:
            verdict(result)
        }
    }

    private var arrowZones: some View {
        ZStack {
            ForEach([ReflexDirection.up, .down, .left, .right], id: \.self) { direction in
                Image(systemName: arrowSymbol(direction)).font(.title3.weight(.bold)).foregroundStyle(.white.opacity(0.35))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment(direction))
                    .padding(10)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func alignment(_ direction: ReflexDirection) -> Alignment {
        switch direction {
        case .up: .top
        case .down: .bottom
        case .left: .leading
        case .right: .trailing
        }
    }

    private func arrowSymbol(_ direction: ReflexDirection?) -> String {
        switch direction {
        case .up: "arrow.up"
        case .down: "arrow.down"
        case .left: "arrow.left"
        case .right: "arrow.right"
        case nil: "questionmark"
        }
    }

    @ViewBuilder
    private func verdict(_ result: Reflex.LiveResult?) -> some View {
        VStack(spacing: 4) {
            switch result?.outcome {
            case .hit:
                Text("\(Int(result?.reactionMs ?? 0)) ms").font(.system(size: 44, weight: .black)).monospacedDigit()
                Text(Reflex.rating(result?.reactionMs ?? 0)).font(.headline)
            case .early:
                Text("Too soon!").font(.system(size: 36, weight: .black))
                Text("−\(Reflex.falseStartPenalty) points").font(.headline)
            case .wrong:
                Text("Wrong way").font(.system(size: 36, weight: .black))
            case .miss:
                Text("Missed").font(.system(size: 36, weight: .black))
            case nil:
                Text(engine.view.stage == .done ? "Done!" : "Round over").font(.system(size: 36, weight: .black))
            }
        }
        .foregroundStyle(.white)
        .accessibilityIdentifier("reflex.verdict")
    }

    private func accessibilityText(view: Reflex.ViewState, round: ReflexRound?, result: Reflex.LiveResult?) -> String {
        guard let round else { return "Arena" }
        let title = Reflex.copy(round.kind).title
        switch view.stage {
        case .before: return "Get ready"
        case .intro: return "Round \(view.index + 1): \(title). \(Reflex.copy(round.kind).instruction)"
        case .wait: return "Wait"
        case .signal:
            switch round.kind {
            case .arrow: return "Now! Arrow \(round.direction?.rawValue ?? "")"
            default: return "Now!"
            }
        case .result, .done:
            return "Round \(view.index + 1): \(OutcomeStyle.label(result))"
        }
    }
}

/// Records presses with the touch's own timestamp (the media clock the
/// display link's frame times are on) and where it landed.
private struct ArenaTouchLayer: UIViewRepresentable {
    let onPress: (CFTimeInterval, CGPoint) -> Void

    func makeUIView(context: Context) -> TouchView {
        let view = TouchView()
        view.backgroundColor = .clear
        view.isMultipleTouchEnabled = false
        return view
    }

    func updateUIView(_ view: TouchView, context: Context) { view.onPress = onPress }

    final class TouchView: UIView {
        var onPress: (CFTimeInterval, CGPoint) -> Void = { _, _ in }
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            guard let touch = touches.first else { return }
            onPress(touch.timestamp, touch.location(in: self))
        }
    }
}

/// Everyone's rounds: mine as I play them, others' from their live frames,
/// and the server's scored breakdown as soon as it's in.
private struct DuelBoard: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition
    let meId: Int?
    let ownResults: [Reflex.LiveResult?]
    let currentIndex: Int

    var body: some View {
        let rounds = lobby.reflex?.rounds ?? []
        let rows = lobby.players.map { player -> (GameLobbyPlayer, [Reflex.LiveResult?], Int) in
            if let scored = lobby.reflex?.results.first(where: { $0.userId == player.user.id }) {
                let results = scored.rounds.map { Optional(Reflex.LiveResult(outcome: $0.outcome, reactionMs: $0.reactionMs)) }
                return (player, results, Int((player.score ?? Double(Reflex.score(rounds, results).total)).rounded()))
            }
            var results: [Reflex.LiveResult?]
            if player.user.id == meId {
                results = ownResults
            } else {
                results = Array(repeating: nil, count: rounds.count)
                for value in env.games.progressHistory(lobby.id, userId: player.user.id) {
                    if let decoded = Reflex.decodeLiveResult(value), decoded.index < rounds.count { results[decoded.index] = decoded.result }
                }
            }
            return (player, results, Reflex.score(rounds, results).total)
        }
        GamePanel(title: lobby.players.count == 1 ? "Your run" : "Duel", systemImage: lobby.players.count == 1 ? "medal" : "person.2.wave.2", identifier: "reflex.board") {
            Text("\(game.scoreUnit) live · final once everyone's in").font(.caption).foregroundStyle(.secondary)
            ForEach(Array(rows.sorted { $0.2 > $1.2 }.enumerated()), id: \.element.0.user.id) { rank, row in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("\(rank + 1)").font(.caption.weight(.bold)).monospacedDigit().foregroundStyle(.secondary)
                        AvatarView(userId: row.0.user.id, size: 22)
                        Text(row.0.user.id == meId ? "You" : row.0.user.shownName).font(.subheadline.weight(.medium)).lineLimit(1)
                        Spacer()
                        Text("\(row.2)").font(.headline).monospacedDigit()
                    }
                    HStack(spacing: 3) {
                        ForEach(0..<rounds.count, id: \.self) { index in
                            let result = index < row.1.count ? row.1[index] : nil
                            Text(OutcomeStyle.label(result))
                                .font(.system(size: 10, weight: .semibold)).monospacedDigit()
                                .lineLimit(1).minimumScaleFactor(0.6)
                                .frame(maxWidth: .infinity, minHeight: 20)
                                .foregroundStyle(OutcomeStyle.foreground(result?.outcome) ?? .secondary)
                                .background(OutcomeStyle.background(result?.outcome), in: RoundedRectangle(cornerRadius: 5))
                        }
                    }
                }
                .padding(8)
                .background(row.0.user.id == meId ? game.theme.from.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 10))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("reflex.row.\(row.0.user.id)")
            }
        }
    }
}

/// The waiting room's "how to play": every round kind.
struct ReflexGuide: View {
    let game: GameDefinition

    var body: some View {
        GamePanel(title: "How to play", systemImage: "questionmark.circle", identifier: "reflex.guide") {
            ForEach(ReflexKind.allCases, id: \.self) { kind in
                let copy = Reflex.copy(kind)
                HStack(spacing: 10) {
                    Image(systemName: copy.systemImage).frame(width: 28).foregroundStyle(game.theme.accentText)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(copy.title).font(.subheadline.weight(.semibold))
                        Text(copy.instruction).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            Text("Tap too early and it costs \(Reflex.falseStartPenalty) points. Clean hits in a row build a combo.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}

/// Under the podium: each player's round-by-round breakdown, as the server
/// scored it.
struct ReflexBreakdown: View {
    let lobby: GameLobby
    let game: GameDefinition
    let meId: Int?

    var body: some View {
        if let reflex = lobby.reflex, !reflex.results.isEmpty {
            GamePanel(title: "Round by round", systemImage: "list.number", identifier: "reflex.breakdown") {
                ForEach(reflex.results, id: \.userId) { result in
                    let name = result.userId == meId ? "You" : lobby.players.first { $0.user.id == result.userId }?.user.shownName ?? "A player who left"
                    VStack(alignment: .leading, spacing: 4) {
                        Text(name).font(.subheadline.weight(.semibold))
                        HStack(spacing: 3) {
                            ForEach(Array(result.rounds.enumerated()), id: \.offset) { index, round in
                                VStack(spacing: 1) {
                                    if index < reflex.rounds.count {
                                        Image(systemName: Reflex.copy(reflex.rounds[index].kind).systemImage).font(.system(size: 9))
                                    }
                                    Text(OutcomeStyle.label(Reflex.LiveResult(outcome: round.outcome, reactionMs: round.reactionMs)))
                                        .font(.system(size: 10, weight: .semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
                                    Text("\(Int(round.points))").font(.system(size: 9)).monospacedDigit()
                                }
                                .frame(maxWidth: .infinity, minHeight: 40)
                                .foregroundStyle(OutcomeStyle.foreground(round.outcome) ?? .secondary)
                                .background(OutcomeStyle.background(round.outcome), in: RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}
