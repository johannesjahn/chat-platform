import XCTest

/// API helpers for the notification and search tests.
extension TestAPI {
    func react(_ user: TestUser, toPost postId: Int, _ emoji: String = "👍") async throws {
        try await request("POST", "/posts/\(postId)/reactions", body: ["emoji": emoji], token: user.accessToken)
    }

    /// The user's inbox, newest first.
    func notifications(_ user: TestUser) async throws -> [[String: Any]] {
        let page = try await request("GET", "/notifications?limit=50", token: user.accessToken) as! [String: Any]
        return page["notifications"] as! [[String: Any]]
    }

    /// The id of `user`'s newest notification of `type`.
    func notificationId(_ user: TestUser, type: String) async throws -> Int {
        let match = try await notifications(user).first { $0["type"] as? String == type }
        guard let id = match?["id"] as? Int else { throw TestAPIError(description: "no \(type) notification") }
        return id
    }

    func createLobby(_ user: TestUser, game: String = "typing") async throws -> Int {
        let lobby = try await request("POST", "/games/\(game)/lobbies", token: user.accessToken) as! [String: Any]
        return lobby["id"] as! Int
    }

    func invite(_ user: TestUser, to lobbyId: Int, _ invitee: TestUser) async throws {
        try await request("POST", "/games/lobbies/\(lobbyId)/invite", body: ["userId": invitee.id], token: user.accessToken)
    }

    func block(_ user: TestUser, _ target: TestUser) async throws {
        try await request("PUT", "/users/\(target.id)/block", body: ["type": "block"], token: user.accessToken)
    }

    func directChat(_ user: TestUser, with other: TestUser) async throws -> Int {
        let chat = try await request("POST", "/chats/direct", body: ["userId": other.id], token: user.accessToken) as! [String: Any]
        return chat["id"] as! Int
    }

    @discardableResult
    func sendMessage(_ user: TestUser, chat chatId: Int, _ text: String) async throws -> Int {
        let message = try await request("POST", "/chats/\(chatId)/messages", body: ["contentType": "text", "content": text], token: user.accessToken) as! [String: Any]
        return message["id"] as! Int
    }
}

final class NotificationsTests: AppTestCase {
    /// Waits for the Alerts badge (mirrored on a hidden element) to read `count`.
    func waitForBadge(_ count: Int, file: StaticString = #filePath, line: UInt = #line) {
        let badge = app.descendants(matching: .any)["notifications.unreadCount"]
        let predicate = NSPredicate(format: "label == %@", String(count))
        let result = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: badge)], timeout: 15)
        if result != .completed {
            screenshot("badge-not-\(count)")
            XCTFail("Badge never read \(count) (it reads \(badge.exists ? badge.label : "nothing"))", file: file, line: line)
        }
    }

    func testLiveNotificationsBadgeOpenAndMarkRead() async throws {
        let me = try await api.makeUser("alice")
        let other = try await api.makeUser("bob")
        let postId = try await api.createPost(me, "Notify me about this")
        launch(as: me)
        element("main.tabs")
        waitForRealtime()
        waitForBadge(0)

        // Someone else comments, reacts and mentions — each lands live.
        let commentText = "Lovely post, alice"
        try await api.createComment(other, on: postId, commentText)
        waitForBadge(1)
        let alertsTab = app.tabBars.buttons["Alerts"]
        XCTAssertTrue((alertsTab.value as? String ?? "").contains("1"), "tab badge: \(String(describing: alertsTab.value))")
        screenshot("01-badge")
        try await api.react(other, toPost: postId)
        waitForBadge(2)
        let mentionPost = try await api.createPost(other, "Hey @\(me.username) take a look")
        waitForBadge(3)

        let commentId = try await api.notificationId(me, type: "comment")
        let reactionId = try await api.notificationId(me, type: "reaction")
        let mentionId = try await api.notificationId(me, type: "mention")

        selectTab("Alerts")
        let commentRow = element("notifications.row.\(commentId)")
        element("notifications.row.\(reactionId)")
        let mentionRow = element("notifications.row.\(mentionId)")
        XCTAssertTrue(commentRow.label.contains("commented on your post"), commentRow.label)
        XCTAssertTrue(commentRow.label.contains(commentText), "the excerpt comes from the server")
        XCTAssertEqual(commentRow.value as? String, "unread")
        screenshot("02-inbox")

        // Tapping opens the post with the comment, and marks the row read.
        commentRow.tap()
        element("feed.post.\(postId)")
        XCTAssertTrue(app.staticTexts[commentText].waitForExistence(timeout: 10))
        screenshot("03-opened-comment")
        waitForBadge(2)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertEqual(element("notifications.row.\(commentId)").value as? String, "read")

        // A mention opens the post it's in.
        mentionRow.tap()
        element("feed.post.\(mentionPost)")
        waitForBadge(1)
        app.navigationBars.buttons.firstMatch.tap()

        // Swipe to mark one read in place.
        let reactionRow = element("notifications.row.\(reactionId)")
        reactionRow.swipeLeft()
        let markRead = app.buttons["Mark read"]
        XCTAssertTrue(markRead.waitForExistence(timeout: 5))
        screenshot("04-swipe")
        markRead.tap()
        waitForBadge(0)
        XCTAssertEqual(element("notifications.row.\(reactionId)").value as? String, "read")
        XCTAssertFalse(element("notifications.markAllRead").isEnabled)
    }

    func testMarkAllReadClearsTheBadge() async throws {
        let me = try await api.makeUser("busy")
        let other = try await api.makeUser("fan")
        let postId = try await api.createPost(me, "Popular post")
        try await api.createComment(other, on: postId, "First!")
        try await api.react(other, toPost: postId, "😂")
        launch(as: me)
        waitForBadge(2)
        selectTab("Alerts")
        let reactionId = try await api.notificationId(me, type: "reaction")
        let row = element("notifications.row.\(reactionId)")
        XCTAssertTrue(row.label.contains("reacted 😂 to your post"), row.label)
        element("notifications.markAllRead").tap()
        waitForBadge(0)
        XCTAssertEqual(row.value as? String, "read")
        screenshot("05-all-read")
        // The server agrees.
        let unread = try await api.notifications(me).filter { ($0["read"] as? Bool) == false }
        XCTAssertTrue(unread.isEmpty)
    }

    func testGameInviteOpensItsLobby() async throws {
        let me = try await api.makeUser("player")
        let host = try await api.makeUser("host")
        let lobbyId = try await api.createLobby(host)
        try await api.invite(host, to: lobbyId, me)
        launch(as: me)
        waitForBadge(1)
        selectTab("Alerts")
        let inviteId = try await api.notificationId(me, type: "game_invite")
        let row = element("notifications.row.\(inviteId)")
        XCTAssertTrue(row.label.contains("invited you to play Type Race"), row.label)
        screenshot("06-invite")
        row.tap()
        // The lobby screen belongs to the games feature; until it lands the
        // route shows its placeholder. Either way the inbox gave way to it.
        let lobby = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == 'route.placeholder' OR identifier BEGINSWITH 'game'")).firstMatch
        XCTAssertTrue(lobby.waitForExistence(timeout: 10))
        waitForBadge(0)
    }

    func testEmptyInbox() async throws {
        let me = try await api.makeUser("quiet")
        launch(as: me)
        selectTab("Alerts")
        element("notifications.empty")
        XCTAssertFalse(element("notifications.markAllRead").isEnabled)
        screenshot("07-empty")
    }
}
