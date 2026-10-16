import Foundation

enum TimeText {
    /// "2 min. ago" style, for a server timestamp in epoch milliseconds.
    static func relative(_ millis: Int, now: Date = Date()) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(millis) / 1000)
        if abs(now.timeIntervalSince(date)) < 45 { return "just now" }
        return date.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated).locale(Locale(identifier: "en_US")))
    }

    static func date(_ millis: Int) -> Date { Date(timeIntervalSince1970: TimeInterval(millis) / 1000) }
}
