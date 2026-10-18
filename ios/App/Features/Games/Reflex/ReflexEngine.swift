import Foundation
import Observation
import QuartzCore

/// Runs one player's Reflex Rush game (`useReflexEngine` on the web): follows
/// the server's schedule frame by frame, judges each press against it for an
/// instant verdict, streams every verdict to the lobby, and hands the whole
/// game over once the last round closes. The server scores what's handed
/// over.
///
/// Reaction times are measured on the media clock: from the display frame
/// that put the signal on screen (the display link's `targetTimestamp` in
/// the tick that switched to it) to the touch's own `timestamp` — not to when
/// a handler got round to running.
@MainActor
@Observable
final class ReflexEngine {
    private(set) var view: Reflex.ViewState
    private(set) var results: [Reflex.LiveResult?]
    private(set) var whiffs: [Whiff] = []

    struct Whiff: Identifiable, Equatable {
        let id: Int
        let x: Double
        let y: Double
    }

    let rounds: [ReflexRound]
    private let introMs: Double
    private let serverNow: () -> Double
    private var taps: [ReflexTap?]
    private var signalShownAt: [Int: CFTimeInterval] = [:]
    private var completed = false
    private var link: CADisplayLink?
    private var nextWhiff = 0
    /// False for a spectator (same show, no controls) and once submitted.
    var enabled: Bool
    var onRecord: (Int, Reflex.LiveResult, [Reflex.LiveResult?], [ReflexTap?]) -> Void = { _, _, _, _ in }
    var onComplete: ([ReflexTap]) -> Void = { _ in }

    init(rounds: [ReflexRound], introMs: Double, enabled: Bool, results: [Reflex.LiveResult?]?, taps: [ReflexTap?]?, serverNow: @escaping () -> Double) {
        self.rounds = rounds
        self.introMs = introMs
        self.enabled = enabled
        self.serverNow = serverNow
        self.results = results?.count == rounds.count ? results! : Array(repeating: nil, count: rounds.count)
        self.taps = taps?.count == rounds.count ? taps! : Array(repeating: nil, count: rounds.count)
        view = Reflex.view(rounds, introMs: introMs, now: serverNow())
    }

    func start() {
        guard link == nil, !rounds.isEmpty else { return }
        let proxy = DisplayLinkProxy { [weak self] link in self?.tick(frameAt: link.targetTimestamp) }
        let link = CADisplayLink(target: proxy, selector: #selector(DisplayLinkProxy.step(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        tick(frameAt: CACurrentMediaTime())
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    /// Advances to the schedule's state at the server's now. Commits only
    /// when something visible changes (a handful of times a round).
    func tick(frameAt: CFTimeInterval) {
        let next = Reflex.view(rounds, introMs: introMs, now: serverNow())
        guard next != view else { return }
        if next.stage == .signal, signalShownAt[next.index] == nil { signalShownAt[next.index] = frameAt }
        view = next
        settleMisses()
        completeIfDone()
    }

    /// A press at `at` (media time) where it landed in the arena (fractions),
    /// or a direction for an arrow pad / VoiceOver action.
    func press(at: CFTimeInterval, x: Double?, y: Double?, direction: ReflexDirection? = nil) {
        guard enabled else { return }
        let index = view.index
        guard rounds.indices.contains(index), results[index] == nil else { return }
        let round = rounds[index]
        switch view.stage {
        case .wait:
            record(index, Reflex.LiveResult(outcome: .early, reactionMs: nil), tap: ReflexTap(early: true, reactionMs: nil, direction: nil, x: nil, y: nil))
        case .signal:
            guard let shownAt = signalShownAt[index] else { return }
            let direction = direction ?? (round.kind == .arrow ? x.flatMap { x in y.map { Reflex.direction(atX: x, y: $0) } } : nil)
            if round.kind == .arrow, direction == nil { return }
            if round.kind == .target {
                guard let x, let y else { return }
                if !Reflex.isOnTarget(round, x: x, y: y) {
                    nextWhiff += 1
                    whiffs = Array((whiffs + [Whiff(id: nextWhiff, x: x, y: y)]).suffix(5))
                    return
                }
            }
            let judged = Reflex.judge(round, reactionMs: (at - shownAt) * 1000, direction: direction, x: x, y: y)
            record(index, judged.result, tap: judged.tap)
        default:
            return
        }
    }

    private func record(_ index: Int, _ result: Reflex.LiveResult, tap: ReflexTap) {
        results[index] = result
        taps[index] = tap
        onRecord(index, result, results, taps)
    }

    /// A round that closed without a press is a miss — told to the lobby at
    /// once so opponents' rows don't sit waiting.
    private func settleMisses() {
        guard enabled, view.stage == .result || view.stage == .done, results[view.index] == nil else { return }
        record(view.index, Reflex.LiveResult(outcome: .miss, reactionMs: nil), tap: Reflex.noTap)
    }

    private func completeIfDone() {
        guard enabled, !completed, view.index == rounds.count - 1, view.stage == .done else { return }
        completed = true
        onComplete(taps.map { $0 ?? Reflex.noTap })
    }

    /// The taps so far, for a retry after a failed submission.
    var allTaps: [ReflexTap] { taps.map { $0 ?? Reflex.noTap } }
}

/// `CADisplayLink` retains its target; this keeps the engine out of that
/// cycle.
@MainActor
private final class DisplayLinkProxy: NSObject {
    let onStep: (CADisplayLink) -> Void
    init(onStep: @escaping (CADisplayLink) -> Void) { self.onStep = onStep }
    @objc func step(_ link: CADisplayLink) { onStep(link) }
}
