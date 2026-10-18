import XCTest

final class AdminTests: AppTestCase {
    func testAnAdminSeesTheDashboard() async throws {
        let admin = try await api.makeAdmin("dash")
        // Some activity so the charts have bars.
        try await api.createPost(admin, "Something for the dashboard")
        launch(as: admin)
        openFromMore("more.admin")
        element("admin.screen")
        let users = element("admin.total.users")
        XCTAssertTrue(users.label.contains("Users"))
        XCTAssertTrue(users.label.contains("admin"))
        element("admin.health.status")
        element("admin.dependency.database")
        screenshot("40-admin-top")

        let list = app.collectionViews.firstMatch
        let chart = app.descendants(matching: .any)["admin.chart.content"]
        var swipes = 0
        while !chart.isHittable && swipes < 8 { list.swipeUp(); swipes += 1 }
        XCTAssertTrue(chart.exists)
        XCTAssertTrue(element("admin.activity").exists)
        screenshot("41-admin-charts")

        // Switching the range refetches without losing what's shown.
        element("admin.range").buttons["30d"].tap()
        XCTAssertTrue(element("admin.chart.content").label.contains("30 days"))
        screenshot("42-admin-30d")
    }

    func testARegularUserHasNoAdminEntry() async throws {
        let user = try await api.makeUser("plain")
        launch(as: user)
        selectTab("More")
        element("more.settings")
        XCTAssertFalse(app.descendants(matching: .any)["more.admin"].exists)
        try await api.request("GET", "/admin/stats", token: user.accessToken, expect: 403..<404)
    }

    func testADemotedAdminIsToldItsAdminsOnly() async throws {
        let admin = try await api.makeAdmin("demoted")
        launch(as: admin)
        selectTab("More")
        element("more.admin")
        // Demoted elsewhere while the app still shows the entry: the server decides.
        let seeded = try await api.seededAdmin()
        try await api.request("PATCH", "/users/\(admin.id)/role", body: ["role": "user"], token: seeded.accessToken)
        element("more.admin").tap()
        // The old token is revoked: the app either signs out or shows the 403 state.
        let forbidden = app.descendants(matching: .any)["admin.forbidden"]
        let signedOut = app.descendants(matching: .any)["auth.screen"]
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !forbidden.exists && !signedOut.exists { _ = forbidden.waitForExistence(timeout: 1) }
        XCTAssertTrue(forbidden.exists || signedOut.exists)
        screenshot("43-admin-forbidden")
    }
}
