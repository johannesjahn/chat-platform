import ChatAPI
import Foundation
import Observation

typealias AdminStats = Components.Schemas.AdminStats

/// `GET /admin/stats` — aggregates only, by design (no per-user breakdown;
/// see CLAUDE.md "Admin dashboard"). The server answers 403 to non-admins.
@MainActor
@Observable
final class AdminStatsModel {
    enum State: Equatable {
        case loading
        case loaded(AdminStats)
        /// The server said no (403): not an admin (any more).
        case forbidden
        case failed(String)
    }

    /// The timeline ranges the web offers, in days.
    static let ranges = [7, 14, 30]

    private(set) var state: State = .loading
    private(set) var isRefreshing = false
    var range = 14

    private let api: APIClient
    private var generation = 0

    init(api: APIClient) { self.api = api }

    var stats: AdminStats? {
        if case .loaded(let stats) = state { return stats }
        return nil
    }

    /// Loads (or refreshes) the snapshot; what's on screen stays while a
    /// refresh or a range change is in flight, and a failed refresh keeps it.
    func load() async {
        generation += 1
        let generation = generation
        let days = String(range)
        if stats == nil { state = .loading }
        isRefreshing = true
        defer { if generation == self.generation { isRefreshing = false } }
        do {
            let stats = try await api.call { try await $0.admin_getAdminStats(query: .init(days: days)) }.ok.body.json
            guard generation == self.generation else { return }
            state = .loaded(stats)
        } catch {
            let error = APIError.from(error)
            guard generation == self.generation, !error.isCancelled else { return }
            if error.status == 403 { state = .forbidden }
            else if stats == nil { state = .failed(error.message) }
        }
    }
}

/// Number formatting shared by the dashboard (mirrors admin.tsx).
enum AdminFormat {
    static func count(_ value: Double) -> String {
        Int(value).formatted(.number)
    }

    static func bytes(_ value: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file)
    }

    /// "0%", "0.25%" under 1%, else one decimal.
    static func percent(_ ratio: Double) -> String {
        if ratio == 0 { return "0%" }
        return String(format: ratio < 0.01 ? "%.2f%%" : "%.1f%%", ratio * 100)
    }

    static func uptime(_ seconds: Double) -> String {
        let s = Int(seconds)
        if s < 60 { return "\(s)s" }
        let minutes = s / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h \(minutes % 60)m" }
        return "\(hours / 24)d \(hours % 24)h"
    }

    /// The chart's y-axis top: the smallest "nice" value at or above `value`
    /// whose half is a whole number too (ActivityChart.tsx's `niceCeiling`).
    static func niceCeiling(_ value: Double) -> Double {
        guard value > 0 else { return 2 }
        let magnitude = pow(10, floor(log10(value)))
        for step in [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] {
            let raw = step * magnitude
            let candidate = abs(raw - raw.rounded()) < 1e-9 ? raw.rounded() : raw
            if candidate >= value, (candidate / 2).rounded() == candidate / 2 { return candidate }
        }
        return 20 * magnitude
    }

    static func windowLabel(_ window: Components.Schemas.AdminActivityWindowLabel) -> String {
        switch window {
        case ._1d: "24 hours"
        case ._7d: "7 days"
        case ._30d: "30 days"
        }
    }

    /// `YYYY-MM-DD` (a UTC day) as local midnight of the same calendar date,
    /// so the chart's local-time labels name the server's day, never its
    /// neighbour.
    static func day(_ string: String, calendar: Calendar = .current) -> Date? {
        let parts = string.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
