import SwiftUI

/// Sketchy's play area. Everything shown comes from the server's
/// `DrawingGame` view for this viewer — the stage and its timer, the
/// viewer's own prompt, drawings once they're in the spotlight, the ballot,
/// the reveal. Nothing about a prompt or the truth is ever worked out here.
struct SketchyPlayView: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition
    let meId: Int?
    let now: Double

    var body: some View {
        if let drawing = lobby.drawing {
            // A player who left the game can come back to watch — as a
            // spectator, without the controls the server would turn away.
            let viewer = lobby.player(meId) != nil ? meId : nil
            VStack(spacing: 16) {
                GamePanel(identifier: "sketchy.panel") {
                    if let stage = drawing.stage {
                        stageHeader(drawing, stage: stage)
                        Group {
                            switch stage.kind {
                            case .draw:
                                DrawStage(lobby: lobby, game: game, drawing: drawing, stage: stage, meId: viewer, now: now)
                            case .bluff:
                                if let entry = spotlight(drawing, stage) { BluffStage(lobby: lobby, game: game, drawing: drawing, entry: entry, meId: viewer) }
                            case .vote:
                                if let entry = spotlight(drawing, stage) { VoteStage(lobby: lobby, game: game, drawing: drawing, entry: entry, meId: viewer) }
                            case .reveal:
                                if let entry = spotlight(drawing, stage) { RevealStage(lobby: lobby, game: game, entry: entry, meId: viewer, now: now) }
                            }
                        }
                        .id("\(stage.kind.rawValue):\(stage.turn):\(stage.drawingId ?? 0)")
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "paintpalette").font(.largeTitle).foregroundStyle(game.theme.accentText)
                            Text("Sharpen your pencils").font(.headline)
                            Text("\(Int(drawing.rounds)) \(drawing.rounds == 1 ? "round" : "rounds") · \(drawing.participantIds.count) artists")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, minHeight: 200)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("sketchy.waiting")
                    }
                }
                .overlay { CountdownOverlay(startsAt: lobby.startsAt, now: now, hint: "Your secret prompt arrives at zero", theme: game.theme) }
                Scoreboard(lobby: lobby, drawing: drawing, meId: viewer)
            }
        }
    }

    private func spotlight(_ drawing: DrawingGame, _ stage: DrawingStage) -> DrawingEntry? {
        guard let id = stage.drawingId else { return nil }
        return drawing.drawings.first { $0.id == id }
    }

    private func stageHeader(_ drawing: DrawingGame, stage: DrawingStage) -> some View {
        let inRound = drawing.drawings.filter { $0.turn == stage.turn }
        let position = spotlight(drawing, stage).map { Int($0.position) + 1 }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                ForEach([DrawingStageKind.draw, .bluff, .vote, .reveal], id: \.self) { kind in
                    Text(kind.rawValue.capitalized)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(kind == stage.kind ? game.theme.onGradient : .secondary)
                        .background {
                            if kind == stage.kind { Capsule().fill(game.theme.gradient) } else { Capsule().fill(Color(.tertiarySystemFill)) }
                        }
                        .accessibilityAddTraits(kind == stage.kind ? .isSelected : [])
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("sketchy.stage")
            .accessibilityValue(stage.kind.rawValue)
            HStack {
                Text("Round \(stage.turn) of \(Int(drawing.rounds))" + (position.map { " · Drawing \($0) of \(inRound.count)" } ?? ""))
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                if stage.kind != .reveal {
                    let left = LobbyTiming.secondsLeft(until: stage.endsAt, now: now)
                    Label("\(left)s", systemImage: "timer")
                        .font(.subheadline.weight(.bold)).monospacedDigit()
                        .foregroundStyle(left <= 10 ? Color.red : Color.primary)
                        .accessibilityLabel("\(left) seconds left")
                        .accessibilityIdentifier("sketchy.timer")
                }
            }
        }
    }
}

@MainActor private func castName(_ lobby: GameLobby, _ userId: Int?, users: UserStore) -> String {
    guard let userId else { return "Nobody" }
    return lobby.player(userId)?.user.shownName ?? users.user(userId)?.shownName ?? "A player who left"
}

// MARK: draw

private struct DrawStage: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition
    let drawing: DrawingGame
    let stage: DrawingStage
    let meId: Int?
    let now: Double

    /// Send this long before the timer runs out, so the drawing lands inside
    /// the stage (the server allows a little grace after it, too).
    private static let autoSubmitLeadMs: Double = 400
    @State private var strokes: [DrawingStroke] = []
    @State private var sending = false
    @State private var sent = false
    @State private var autoSent = false
    @State private var error: String?

    var body: some View {
        let round = drawing.drawings.filter { $0.turn == stage.turn }
        let mine = round.first { $0.artistId == meId }
        let done = mine?.submitted == true || sent
        VStack(spacing: 14) {
            if mine != nil, let prompt = drawing.myPrompt {
                VStack(spacing: 4) {
                    Label("Your secret prompt", systemImage: "sparkles").font(.caption.weight(.semibold)).textCase(.uppercase).foregroundStyle(.secondary)
                    Text(prompt).font(.title2.weight(.black)).multilineTextAlignment(.center).foregroundStyle(game.theme.accentText)
                        .accessibilityIdentifier("sketchy.prompt")
                    Text("Don't write it out — others have to guess it from the picture.").font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(12)
                .background(game.theme.from.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
            }
            if mine != nil, !done {
                SketchCanvas(strokes: $strokes, disabled: sending)
                Button { Task { await send() } } label: {
                    Label(strokes.isEmpty ? "Submit a blank canvas" : "I'm done", systemImage: "paperplane.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(GameButtonStyle(theme: game.theme))
                .disabled(sending)
                .accessibilityIdentifier("sketchy.submitDrawing")
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            } else if let mine, done {
                VStack(spacing: 6) {
                    DrawingView(strokes: mine.strokes ?? strokes, label: "Your drawing", identifier: "sketchy.myDrawing")
                        .frame(maxWidth: 260)
                    Text("Sent! Nice work.").font(.subheadline.weight(.medium)).accessibilityIdentifier("sketchy.drawingSent")
                }
            } else {
                Text("Everyone is drawing their secret prompt. You'll see the drawings in a moment.")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            Roster(lobby: lobby, entries: round, label: "drawn")
        }
        .onChange(of: now >= Double(stage.endsAt) - Self.autoSubmitLeadMs) { _, due in
            // Time's up: whatever is on the canvas goes in, once.
            if due, mine != nil, !done, !autoSent, !sending {
                autoSent = true
                Task { await send() }
            }
        }
    }

    private func send() async {
        sending = true
        defer { sending = false }
        do {
            try await env.games.submitDrawing(lobby.id, strokes: strokes)
            sent = true
            error = nil
        } catch {
            self.error = APIError.from(error).message
        }
    }
}

/// Who's in for this stage — "3 of 4", as avatars checking in.
private struct Roster: View {
    let lobby: GameLobby
    let entries: [DrawingEntry]
    let label: String

    var body: some View {
        HStack(spacing: 6) {
            ForEach(entries, id: \.id) { entry in
                AvatarView(userId: entry.artistId, size: 26)
                    .opacity(entry.submitted ? 1 : 0.35)
                    .overlay(alignment: .bottomTrailing) {
                        if entry.submitted { Image(systemName: "checkmark.circle.fill").font(.caption2).foregroundStyle(.green).background(Circle().fill(.background)) }
                    }
            }
            Text("\(entries.filter(\.submitted).count) of \(entries.count) \(label)").font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(entries.filter(\.submitted).count) of \(entries.count) \(label)")
        .accessibilityIdentifier("sketchy.roster")
    }
}

// MARK: bluff

private struct BluffStage: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition
    let drawing: DrawingGame
    let entry: DrawingEntry
    let meId: Int?
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        let isArtist = entry.artistId == meId
        let playing = meId.map { drawing.participantIds.contains($0) } ?? false
        VStack(spacing: 14) {
            DrawingView(strokes: entry.strokes ?? [], label: "\(castName(lobby, entry.artistId, users: env.users))'s drawing")
            Text(isArtist ? "Your drawing" : "By \(castName(lobby, entry.artistId, users: env.users))").font(.caption).foregroundStyle(.secondary)
            if isArtist {
                VStack(spacing: 4) {
                    Text("This one's yours!").font(.headline)
                    Text("Everyone is inventing fake titles for it. The real one was").font(.footnote).foregroundStyle(.secondary)
                    // The server only fills this in for the artist.
                    Text(entry.prompt ?? "").font(.title3.weight(.bold)).foregroundStyle(game.theme.accentText)
                }
                .multilineTextAlignment(.center)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("sketchy.bluff.artist")
            } else if !playing {
                Text("The players are inventing fake titles.").font(.subheadline).foregroundStyle(.secondary)
            } else if let mine = entry.myBluff {
                Label("Your bluff is in: “\(mine)”", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.medium)).foregroundStyle(.green)
                    .accessibilityIdentifier("sketchy.bluff.done")
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("What is this?").font(.headline)
                    Text("Write a title the others will believe is the real prompt. Each player who picks yours earns you 500.")
                        .font(.footnote).foregroundStyle(.secondary)
                    HStack {
                        TextField("a very convincing lie", text: $text)
                            .textInputAutocapitalization(.never)
                            .submitLabel(.send)
                            .onSubmit { Task { await send() } }
                            .accessibilityIdentifier("sketchy.bluff.field")
                        Text("\(Sketch.maxBluffLength - text.count)").font(.caption).monospacedDigit()
                            .foregroundStyle(text.count > Sketch.maxBluffLength ? .red : .secondary)
                    }
                    .padding(10)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                    if let error { Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("sketchy.bluff.error") }
                    Button { Task { await send() } } label: {
                        Label("Submit bluff", systemImage: "paperplane.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(GameButtonStyle(theme: game.theme))
                    .disabled(sending || trimmed.isEmpty || trimmed.count > Sketch.maxBluffLength)
                    .accessibilityIdentifier("sketchy.bluff.submit")
                }
            }
            Text("\(entry.bluffCount) of \(max(drawing.participantIds.count - 1, 0)) bluffs in").font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("sketchy.bluff.progress")
        }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func send() async {
        guard !trimmed.isEmpty else { return }
        sending = true
        defer { sending = false }
        do {
            try await env.games.submitBluff(lobby.id, text: trimmed)
            error = nil
        } catch {
            // Too close to the truth, or a copy of someone else's.
            self.error = APIError.from(error).message
        }
    }
}

// MARK: vote

private struct VoteStage: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition
    let drawing: DrawingGame
    let entry: DrawingEntry
    let meId: Int?
    @State private var pending: Int?
    @State private var error: String?

    var body: some View {
        let isArtist = entry.artistId == meId
        let playing = meId.map { drawing.participantIds.contains($0) } ?? false
        let canVote = playing && !isArtist && entry.myVote == nil
        let picked = entry.myVote.map { Int($0) } ?? pending
        VStack(spacing: 14) {
            Text(isArtist ? "They're voting on your drawing" : canVote ? "Which one is the real title?" : playing ? "Vote locked in" : "The players are voting")
                .font(.headline).multilineTextAlignment(.center)
                .accessibilityIdentifier("sketchy.vote.title")
            DrawingView(strokes: entry.strokes ?? [], label: "\(castName(lobby, entry.artistId, users: env.users))'s drawing")
            ForEach(Array((entry.answers ?? []).enumerated()), id: \.element.id) { index, answer in
                let chosen = picked == answer.id
                Button { Task { await vote(answer.id) } } label: {
                    HStack(spacing: 10) {
                        Text(chosen ? "✓" : String(UnicodeScalar(65 + index).map(Character.init) ?? "?"))
                            .font(.subheadline.weight(.bold))
                            .frame(width: 28, height: 28)
                            .foregroundStyle(chosen ? game.theme.onGradient : .secondary)
                            .background { if chosen { Circle().fill(game.theme.gradient) } else { Circle().stroke(Color(.separator)) } }
                        Text(answer.text).font(.body).multilineTextAlignment(.leading)
                        Spacer()
                        if answer.mine {
                            Label(isArtist ? "Real" : "Yours", systemImage: "lock.fill").font(.caption2.weight(.bold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(12)
                    .background(chosen ? game.theme.from.opacity(0.18) : Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
                    .opacity(picked != nil && !chosen ? 0.55 : 1)
                }
                .buttonStyle(.plain)
                .disabled(answer.mine || !canVote || pending != nil)
                .accessibilityAddTraits(chosen ? .isSelected : [])
                .accessibilityIdentifier("sketchy.answer.\(answer.id)")
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            Text("\(entry.voteCount) of \(max(drawing.participantIds.count - 1, 0)) votes in").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func vote(_ answer: Int) async {
        pending = answer
        defer { pending = nil }
        do {
            try await env.games.submitVote(lobby.id, answer: answer)
            error = nil
        } catch {
            self.error = APIError.from(error).message
        }
    }
}

// MARK: reveal

/// The reveal plays off the server's `revealAt` stamps, so everyone sees each
/// card turn at the same moment: bluffs that fooled someone first, the truth
/// last.
private struct RevealStage: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition
    let entry: DrawingEntry
    let meId: Int?
    let now: Double

    var body: some View {
        let answers = entry.answers ?? []
        let sequence = answers.filter { $0.revealAt != nil }.sorted { ($0.revealAt ?? 0) < ($1.revealAt ?? 0) }
        let unpicked = answers.filter { $0.revealAt == nil }
        let flipped = sequence.filter { now >= Double($0.revealAt ?? 0) }
        let truthOut = flipped.contains { $0.real == true }
        VStack(spacing: 12) {
            DrawingView(strokes: entry.strokes ?? [], label: "\(castName(lobby, entry.artistId, users: env.users))'s drawing")
                .overlay(alignment: .bottom) {
                    if truthOut, let prompt = entry.prompt {
                        Text(prompt).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 8))
                            .padding(10)
                            .accessibilityIdentifier("sketchy.reveal.prompt")
                    }
                }
            Text("Drawn by \(castName(lobby, entry.artistId, users: env.users))").font(.caption).foregroundStyle(.secondary)
            if flipped.isEmpty {
                Text("Let's see who fooled whom…").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            }
            ForEach(sequence, id: \.id) { answer in
                card(answer, shown: now >= Double(answer.revealAt ?? 0))
            }
            if truthOut, !unpicked.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Nobody fell for", systemImage: "moon.zzz").font(.caption.weight(.bold)).textCase(.uppercase).foregroundStyle(.secondary)
                    ForEach(unpicked, id: \.id) { answer in
                        Text("“\(answer.text)” — \(castName(lobby, answer.authorId, users: env.users))").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sketchy.reveal")
    }

    @ViewBuilder
    private func card(_ answer: DrawingAnswer, shown: Bool) -> some View {
        if !shown {
            HStack {
                Text("?").font(.headline).frame(width: 28)
                Text(answer.text).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(12)
            .background(Color(.tertiarySystemFill).opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .combine)
        } else {
            let real = answer.real == true
            let voters = (answer.voterIds ?? []).map { castName(lobby, $0, users: env.users) }
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(real ? "THE TRUTH" : "BLUFF").font(.caption.weight(.black))
                        .foregroundStyle(real ? game.theme.onGradient : Color.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background { if real { Capsule().fill(game.theme.gradient) } else { Capsule().fill(Color(.tertiarySystemFill)) } }
                    Spacer()
                    if let points = answer.points, points > 0 {
                        Text("+\(Int(points))").font(.subheadline.weight(.bold)).monospacedDigit().foregroundStyle(game.theme.accentText)
                    }
                }
                Text(answer.text).font(.body.weight(.semibold))
                Text(real ? "By \(castName(lobby, entry.artistId, users: env.users))" : "Written by \(castName(lobby, answer.authorId, users: env.users))")
                    .font(.caption).foregroundStyle(.secondary)
                if !voters.isEmpty {
                    Text((real ? "Found by " : "Fooled ") + voters.joined(separator: ", ")).font(.caption)
                } else if real {
                    Text("Nobody found it").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(real ? game.theme.from.opacity(0.16) : Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("sketchy.reveal.\(answer.id)")
        }
    }
}

// MARK: scores, settings, gallery

private struct Scoreboard: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let drawing: DrawingGame
    let meId: Int?

    var body: some View {
        GamePanel(title: "Scores", systemImage: "trophy", identifier: "sketchy.scores") {
            if drawing.scores.isEmpty {
                Text("Scores appear after the first reveal.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(Array(drawing.scores.enumerated()), id: \.element.userId) { index, score in
                HStack(spacing: 8) {
                    Text("\(index + 1)").font(.caption.weight(.bold)).monospacedDigit().foregroundStyle(.secondary)
                    AvatarView(userId: score.userId, size: 24)
                    Text(score.userId == meId ? "You" : castName(lobby, score.userId, users: env.users)).font(.subheadline).lineLimit(1)
                    Spacer()
                    Text("\(Int(score.score))").font(.subheadline.weight(.bold)).monospacedDigit()
                }
                .accessibilityElement(children: .combine)
            }
        }
        .task(id: drawing.participantIds) { await env.users.ensure(drawing.participantIds) }
    }
}

/// The host picks theme packs and the round count while waiting; everyone
/// else sees the picks live.
struct SketchySettings: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition
    let isHost: Bool
    @State private var packs: [DrawingPack] = []
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        let chosen = lobby.drawing?.packs ?? []
        let rounds = Int(lobby.drawing?.rounds ?? 1)
        GamePanel(title: "Game settings", systemImage: "slider.horizontal.3", identifier: "sketchy.settings") {
            if isHost {
                Stepper("Rounds: \(rounds)", value: Binding(get: { rounds }, set: { new in Task { await save(packs: chosen, rounds: new) } }), in: 1...3)
                    .disabled(saving)
                    .accessibilityIdentifier("sketchy.settings.rounds")
            } else {
                Text("Rounds: \(rounds)").font(.subheadline)
            }
            Text("Theme packs").font(.subheadline.weight(.semibold))
            if packs.isEmpty {
                Text(chosen.joined(separator: ", ")).font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(packs, id: \.slug) { pack in
                let on = chosen.contains(pack.slug)
                Button {
                    var next = chosen
                    if on { next.removeAll { $0 == pack.slug } } else { next.append(pack.slug) }
                    if !next.isEmpty { Task { await save(packs: next, rounds: rounds) } }
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Text(pack.icon).font(.title3)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(pack.name).font(.subheadline.weight(.semibold))
                            Text(pack.description).font(.caption).foregroundStyle(.secondary)
                            Text("e.g. " + pack.samples.prefix(2).joined(separator: ", ")).font(.caption2).foregroundStyle(.tertiary)
                        }
                        Spacer()
                        Image(systemName: on ? "checkmark.circle.fill" : "circle").foregroundStyle(on ? game.theme.accentText : .secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!isHost || saving)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("sketchy.pack.\(pack.slug)")
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .task { packs = (try? await env.games.loadPacks()) ?? [] }
    }

    private func save(packs: [String], rounds: Int) async {
        saving = true
        defer { saving = false }
        do {
            try await env.games.updateDrawingSettings(lobby.id, packs: packs, rounds: rounds)
            error = nil
        } catch {
            self.error = APIError.from(error).message
        }
    }
}

/// After the game: every drawing with its (now revealed) prompt.
struct SketchyGallery: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby

    var body: some View {
        if let drawing = lobby.drawing, !drawing.drawings.isEmpty {
            GamePanel(title: "Gallery", systemImage: "photo.on.rectangle", identifier: "sketchy.gallery") {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                    ForEach(drawing.drawings, id: \.id) { entry in
                        VStack(alignment: .leading, spacing: 4) {
                            DrawingView(strokes: entry.strokes ?? [], label: entry.prompt ?? "Drawing", identifier: "sketchy.gallery.\(entry.id)")
                            Text(entry.prompt ?? "—").font(.caption.weight(.semibold)).lineLimit(2)
                            Text(castName(lobby, entry.artistId, users: env.users)).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}
