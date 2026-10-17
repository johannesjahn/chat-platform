import Foundation
import Synchronization
import Testing

@testable import ChatPlatform

private let statsJSON = """
{"generatedAt":1700000000000,
 "totals":{"users":3,"admins":1,"posts":5,"comments":2,"chats":1,"messages":9,"reactions":4,"attachments":1,"attachmentBytes":2048},
 "activity":[{"window":"1d","activeUsers":1,"newUsers":1,"newPosts":1,"newComments":0,"newMessages":0,"newReactions":0}],
 "timeline":[{"date":"2026-10-16","signups":1,"posts":1,"comments":0,"messages":0}],
 "health":{"status":"ok","version":"0.38.1","uptimeSeconds":3700,"dependencies":[{"name":"database","reachable":true,"latencyMs":1,"backend":"pglite"}],
   "websocketConnections":1,"requestsTotal":10,"serverErrorsTotal":0,"errorRate":0,"rateLimitRejectionsTotal":0,"dbQueryErrorsTotal":0}}
"""

@Suite struct AdminFormatTests {
    @Test func formatsLikeTheWebDashboard() {
        #expect(AdminFormat.percent(0) == "0%")
        #expect(AdminFormat.percent(0.0025) == "0.25%")
        #expect(AdminFormat.percent(0.125) == "12.5%")
        #expect(AdminFormat.uptime(42) == "42s")
        #expect(AdminFormat.uptime(3700) == "1h 1m")
        #expect(AdminFormat.uptime(90_000) == "1d 1h")
        #expect(AdminFormat.windowLabel(._7d) == "7 days")
    }

    @Test func chartCeilingIsANiceEvenNumber() {
        #expect(AdminFormat.niceCeiling(0) == 2)
        #expect(AdminFormat.niceCeiling(1) == 2)
        #expect(AdminFormat.niceCeiling(3) == 4)
        #expect(AdminFormat.niceCeiling(13) == 20)
        #expect(AdminFormat.niceCeiling(11) == 12)
        #expect(AdminFormat.niceCeiling(70) == 80)
    }

    @Test func timelineDaysKeepTheirCalendarDateInAnyTimeZone() throws {
        for zone in ["UTC", "America/Los_Angeles", "Pacific/Auckland"] {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: zone)!
            let day = try #require(AdminFormat.day("2026-10-16", calendar: calendar))
            let parts = calendar.dateComponents([.year, .month, .day], from: day)
            #expect(parts.year == 2026 && parts.month == 10 && parts.day == 16)
        }
        #expect(AdminFormat.day("nonsense") == nil)
    }
}

@MainActor
@Suite struct AdminStatsModelTests {
    private func makeModel(_ backend: FakeBackend) -> AdminStatsModel {
        let urlSession = StubURLProtocol.session()
        let sessions = SessionManager(storage: InMemoryStorage(), refresher: URLSessionRefresher(baseURL: backend.baseURL, session: urlSession))
        return AdminStatsModel(api: APIClient(baseURL: backend.baseURL, sessions: sessions, urlSession: urlSession))
    }

    @Test func loadsTheChosenRange() async {
        let backend = FakeBackend { _ in .json(statsJSON) }
        let model = makeModel(backend)
        model.range = 30
        await model.load()
        #expect(model.stats?.totals.users == 3)
        #expect(backend.requests.first?.path == "/admin/stats")
        #expect(backend.requests.first?.query == "days=30")
    }

    @Test func aForbiddenAnswerIsItsOwnState() async {
        let backend = FakeBackend { _ in .json(#"{"_tag":"Forbidden","message":"Admins only"}"#, status: 403) }
        let model = makeModel(backend)
        await model.load()
        #expect(model.state == .forbidden)
    }

    @Test func aFailedRefreshKeepsTheDashboard() async {
        let failing = Mutex(false)
        let backend = FakeBackend { _ in failing.withLock { $0 } ? .json("{}", status: 500) : .json(statsJSON) }
        let model = makeModel(backend)
        await model.load()
        failing.withLock { $0 = true }
        await model.load()
        #expect(model.stats != nil)
    }
}
