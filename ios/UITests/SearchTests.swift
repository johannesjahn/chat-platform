import XCTest

final class SearchTests: AppTestCase {
    /// A word nobody else's data contains (letters only, so it's one token).
    private func uniqueToken() -> String {
        "zq" + String((0..<8).map { _ in "abcdefghijklmnopqrstuvwxyz".randomElement()! })
    }

    private func openSearch() {
        openFeed()
        element("feed.search").tap()
    }

    private func search(_ text: String) {
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        if let current = field.value as? String, !current.isEmpty, current != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        field.typeText(text)
    }

    /// Scrolls the results until `id` is on screen.
    @discardableResult
    private func result(_ id: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let target = app.descendants(matching: .any)[id]
        if !target.waitForExistence(timeout: 10) {
            let list = app.descendants(matching: .any)["search.results"]
            for _ in 0..<6 where !target.exists && list.exists { list.swipeUp() }
        }
        XCTAssertTrue(target.waitForExistence(timeout: 5), "Missing result \(id)", file: file, line: line)
        return target
    }

    private func selectScope(_ scope: String) {
        let chip = element("search.scope.\(scope)")
        // The chip row scrolls sideways on a narrow phone.
        let row = element("search.scopes")
        for _ in 0..<3 where !chip.isHittable {
            if ["all", "users", "posts"].contains(scope) { row.swipeRight() } else { row.swipeLeft() }
        }
        chip.tap()
        XCTAssertTrue(chip.isSelected, "scope \(scope) not selected")
    }

    func testUnifiedSearchAndEveryKindsOwnTab() async throws {
        let token = uniqueToken()
        let me = try await api.makeUser("seeker")
        let other = try await api.makeUser(token)
        let postId = try await api.createPost(other, "Release notes for \(token) are out")
        let commentId = try await api.createComment(other, on: postId, "More about \(token) here")
        let chatId = try await api.directChat(other, with: me)
        let messageId = try await api.sendMessage(other, chat: chatId, "Did you see \(token) yet")

        launch(as: me)
        openSearch()
        element("search.hint")
        screenshot("01-hint")
        search(token)

        let post = result("search.result.post.\(postId)")
        XCTAssertTrue((post.value as? String ?? "").contains("Matched: \(token)"), "snippet not highlighted: \(String(describing: post.value))")
        result("search.result.user.\(other.id)")
        screenshot("02-all")
        result("search.result.comment.\(commentId)")
        result("search.result.message.\(messageId)")
        screenshot("03-all-scrolled")

        selectScope("users")
        let person = result("search.result.user.\(other.id)")
        XCTAssertTrue((person.value as? String ?? "").contains("Matched"), "name not highlighted")
        screenshot("04-people")
        selectScope("posts")
        result("search.result.post.\(postId)")
        screenshot("05-posts")
        selectScope("comments")
        let comment = result("search.result.comment.\(commentId)")
        XCTAssertTrue((comment.value as? String ?? "").contains("Matched: \(token)"))
        screenshot("06-comments")
        selectScope("messages")
        let message = result("search.result.message.\(messageId)")
        XCTAssertTrue(message.label.contains(other.username), message.label)
        screenshot("07-messages")

        // A comment hit opens its post.
        selectScope("comments")
        result("search.result.comment.\(commentId)").tap()
        element("feed.post.\(postId)")
        XCTAssertTrue(app.staticTexts["More about \(token) here"].waitForExistence(timeout: 10))
    }

    func testFragmentInsideAWordMatches() async throws {
        let token = uniqueToken()
        let me = try await api.makeUser("finder")
        let postId = try await api.createPost(me, "The word un\(token)able hides it")
        launch(as: me)
        openSearch()
        search(token)
        let post = result("search.result.post.\(postId)")
        XCTAssertTrue((post.value as? String ?? "").contains("Matched: \(token)"), String(describing: post.value))
        screenshot("08-substring")
        post.tap()
        element("feed.post.\(postId)")
    }

    func testNoResultsAndEmptyTabs() async throws {
        let me = try await api.makeUser("lonely")
        launch(as: me)
        openSearch()
        search("q")
        element("search.hint") // one character isn't searched
        search(uniqueToken() + "nothing")
        element("search.noResults")
        screenshot("09-no-results")
        selectScope("posts")
        element("search.empty")
        screenshot("10-empty-tab")
    }

    func testBlockedUsersContentIsHidden() async throws {
        let token = uniqueToken()
        let me = try await api.makeUser("blocker")
        let blocked = try await api.makeUser("pest")
        let friend = try await api.makeUser("pal")
        let hidden = try await api.createPost(blocked, "Spam about \(token)")
        let shown = try await api.createPost(friend, "Useful about \(token)")
        try await api.block(me, blocked)
        launch(as: me)
        openSearch()
        search(token)
        result("search.result.post.\(shown)")
        XCTAssertFalse(app.descendants(matching: .any)["search.result.post.\(hidden)"].exists)
        selectScope("posts")
        result("search.result.post.\(shown)")
        XCTAssertFalse(app.descendants(matching: .any)["search.result.post.\(hidden)"].exists)
        screenshot("11-blocked-hidden")
    }
}
