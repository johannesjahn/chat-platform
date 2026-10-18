import SwiftUI
import UIKit

/// The typing race's play area: the racer's passage with live correctness
/// and stats on top, every racer's lane below, under the countdown until the
/// start. Positions stream to the lobby as `game_progress` frames; the finish
/// goes to the server, which checks the text and times it.
struct TypingRaceView: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition
    let meId: Int?
    let now: Double

    @State private var engine = TypingEngine(passage: "")
    @State private var throttle = ProgressThrottle()
    @State private var submitting = false
    @State private var submitError: String?
    @State private var lastTyped: (typed: String, errors: Int)?

    private var passage: String { lobby.passage ?? "" }
    private var startsAt: Double { Double(lobby.startsAt ?? 0) }
    private var me: GameLobbyPlayer? { lobby.player(meId) }
    private var finished: Bool { me?.place != nil }
    private var racing: Bool { now >= startsAt && Double(lobby.endsAt ?? 0) > now }
    private var canType: Bool { me != nil && racing && !finished && !submitting }

    var body: some View {
        VStack(spacing: 16) {
            if let me {
                GamePanel(identifier: "race.panel") {
                    stats(me)
                    if finished, let place = me.place {
                        VStack(spacing: 4) {
                            Text("FINISHED").font(.caption.weight(.bold)).tracking(3).foregroundStyle(.secondary)
                            Text(GameFormat.ordinal(place)).font(.system(size: 48, weight: .black, design: .rounded))
                                .foregroundStyle(game.theme.accentText)
                            Text(String(format: "%d %@ · %.1f%% accuracy · %@", Int((me.score ?? 0).rounded()), game.scoreUnit, me.accuracy ?? 0, GameFormat.duration(me.durationMs ?? 0)))
                                .font(.footnote).monospacedDigit().foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 16)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("race.finished")
                    } else {
                        PassageText(engine: engine, theme: game.theme)
                        RaceInput(text: engine.typedText, enabled: canType, onChange: handleInput)
                            .frame(height: 44)
                            .padding(.horizontal, 12)
                            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(canType ? game.theme.from : .clear, lineWidth: 2))
                            .accessibilityIdentifier("race.input")
                        if submitting { ProgressView("Checking your finish…").font(.footnote) }
                    }
                    if let submitError {
                        HStack {
                            Text(submitError).font(.footnote).foregroundStyle(.red)
                            if let lastTyped {
                                Button("Send again") { Task { await submit(lastTyped.typed, lastTyped.errors) } }
                                    .font(.footnote.weight(.semibold))
                            }
                        }
                        .accessibilityIdentifier("race.error")
                    }
                }
                .overlay { CountdownOverlay(startsAt: lobby.startsAt, now: now, hint: "Type the passage as fast as you can", theme: game.theme) }
            }
            GamePanel(title: "Track", systemImage: "flag.checkered", identifier: "race.track") {
                ForEach(lobby.players, id: \.user.id) { player in lane(player) }
            }
            .overlay { if me == nil { CountdownOverlay(startsAt: lobby.startsAt, now: now, theme: game.theme) } }
        }
        .onAppear { if engine.passage.isEmpty, !passage.isEmpty { engine = TypingEngine(passage: passage) } }
        .onChange(of: passage) { _, new in engine = TypingEngine(passage: new); throttle.reset() }
        .onChange(of: Int(now / 300)) { _, _ in
            // The trailing flush, so a pause just after a throttled
            // keystroke still shows the exact position.
            if canType, throttle.flush(engine.correct, at: localNowMs()) {
                env.games.sendProgress(lobby.id, engine.correct, me: meId)
            }
        }
    }

    private func stats(_ me: GameLobbyPlayer) -> some View {
        let elapsed = max(0, now - startsAt)
        let wpm = finished ? (me.score ?? 0) : TypingEngine.wordsPerMinute(chars: engine.correct, elapsedMs: elapsed)
        let accuracy = finished ? (me.accuracy ?? 0) : engine.accuracy
        return HStack(spacing: 8) {
            StatTile(label: "Speed", value: "\(Int(wpm.rounded())) \(game.scoreUnit)", emphasis: game.theme.accentText, identifier: "race.wpm")
            StatTile(label: "Accuracy", value: finished ? String(format: "%.1f%%", accuracy) : "\(Int(accuracy.rounded()))%", identifier: "race.accuracy")
            StatTile(label: "Time", value: GameFormat.duration(finished ? (me.durationMs ?? 0) : elapsed))
        }
    }

    private func lane(_ player: GameLobbyPlayer) -> some View {
        let isMe = player.user.id == meId
        let total = max(passage.count, 1)
        let chars = player.place != nil ? total : isMe ? engine.correct : min(env.games.progress(lobby.id, userId: player.user.id), total)
        let fraction = Double(chars) / Double(total)
        let elapsed = max(0, now - startsAt)
        let wpm = player.score ?? (now < startsAt ? nil : TypingEngine.wordsPerMinute(chars: chars, elapsedMs: elapsed))
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                AvatarView(userId: player.user.id, size: 22)
                Text(isMe ? "You" : player.user.shownName).font(.caption.weight(.semibold)).lineLimit(1)
                if player.user.id == lobby.hostId { Image(systemName: "crown.fill").font(.caption2).foregroundStyle(PlaceBadge.color(1)) }
                Spacer()
                if let wpm { Text("\(Int(wpm.rounded())) \(game.scoreUnit)").font(.caption).monospacedDigit().foregroundStyle(.secondary) }
                if let place = player.place { PlaceBadge(place: place, size: 20) }
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color(.tertiarySystemFill))
                    Capsule().fill(game.theme.gradient).frame(width: max(8, proxy.size.width * fraction))
                }
            }
            .frame(height: 8)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(isMe ? "You" : player.user.shownName): \(Int((fraction * 100).rounded())) percent\(player.place.map { ", finished \(GameFormat.ordinal($0))" } ?? "")")
        .accessibilityIdentifier("race.lane.\(player.user.id)")
        .accessibilityValue("\(chars)")
    }

    /// The field changed: run it through the engine, stream the position, and
    /// hand the finish to the server the moment the passage is typed exactly.
    private func handleInput(_ text: String) -> String {
        guard canType else { return engine.typedText }
        let wasDone = engine.done
        let shown = engine.input(text)
        if throttle.shouldSend(engine.correct, at: localNowMs(), force: engine.done || engine.atWordBoundary) {
            env.games.sendProgress(lobby.id, engine.correct, me: meId)
        }
        if engine.done, !wasDone {
            let typed = engine.typedText
            let errors = engine.errors
            Task { await submit(typed, errors) }
        }
        return shown
    }

    private func submit(_ typed: String, _ errors: Int) async {
        lastTyped = (typed, errors)
        submitting = true
        defer { submitting = false }
        do {
            try await env.games.finishRace(lobby.id, typed: typed, errors: errors)
            submitError = nil
        } catch {
            submitError = APIError.from(error).message
        }
    }
}

/// The passage, colored as it's typed: done in the primary color, a mistake
/// in red, the cursor underlined, the rest dimmed.
private struct PassageText: View {
    let engine: TypingEngine
    let theme: GameTheme

    var body: some View {
        Text(attributed)
            .font(.system(.body, design: .monospaced))
            .lineSpacing(4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel(String(engine.passage))
            .accessibilityValue("\(engine.correct) of \(engine.passage.count) characters typed, \(engine.errors) mistakes")
            .accessibilityIdentifier("race.passage")
    }

    private var attributed: AttributedString {
        var result = AttributedString()
        let typed = Array(engine.typedText)
        for (index, char) in engine.passage.enumerated() {
            var piece = AttributedString(String(char))
            if index < engine.correct {
                piece.foregroundColor = theme.accentText
            } else if index < typed.count {
                piece.foregroundColor = .white
                piece.backgroundColor = .red
            } else {
                piece.foregroundColor = .secondary
                if index == typed.count { piece.underlineStyle = .single }
            }
            result += piece
        }
        return result
    }
}

/// A plain UITextField: no autocorrection, smart punctuation or
/// capitalization, any of which would type something other than what was
/// pressed. The engine decides what the field shows (it caps a runaway
/// mistake), so the text is written back after every change.
private struct RaceInput: UIViewRepresentable {
    let text: String
    let enabled: Bool
    let onChange: (String) -> String

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.inlinePredictionType = .no
        field.keyboardType = .asciiCapable
        field.returnKeyType = .done
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.placeholder = "Type here when the race starts"
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.accessibilityLabel = "Race input"
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.onChange = onChange
        if field.text != text { field.text = text }
        let wasEnabled = field.isEnabled
        field.isEnabled = enabled
        // Straight into the passage the moment typing unlocks.
        if enabled, !wasEnabled || !field.isFirstResponder, context.coordinator.focusOnEnable {
            context.coordinator.focusOnEnable = false
            DispatchQueue.main.async { field.becomeFirstResponder() }
        }
        if !enabled { context.coordinator.focusOnEnable = true }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onChange: onChange) }

    @MainActor
    final class Coordinator: NSObject {
        var onChange: (String) -> String
        var focusOnEnable = true
        init(onChange: @escaping (String) -> String) { self.onChange = onChange }

        @objc func changed(_ field: UITextField) {
            let shown = onChange(field.text ?? "")
            if field.text != shown { field.text = shown }
        }
    }
}
