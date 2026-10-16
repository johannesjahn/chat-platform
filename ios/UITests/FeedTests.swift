import XCTest

final class FeedTests: AppTestCase {
    /// The id in a `feed.post.<id>` element.
    private func postId(of element: XCUIElement) -> Int {
        Int(element.identifier.replacingOccurrences(of: "feed.post.", with: ""))!
    }

    func testCreatePostThenCommentReactAndSeeItInTheFeed() async throws {
        let user = try await api.makeUser("poster")
        launch(as: user)
        openFeed()
        // (The feed is global and the backend shared, so it isn't empty.)
        element("feed.compose").tap()
        let text = app.textViews["composer.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        text.tap()
        text.typeText("Hello from the iPhone app")
        screenshot("02-composer")
        element("composer.submit").tap()

        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'feed.post.'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let id = postId(of: row)
        XCTAssertTrue(app.staticTexts["Hello from the iPhone app"].exists)
        screenshot("03-feed-with-post")

        // Open it, comment, and react.
        row.tap()
        element("comments.empty")
        let field = element("comment.composer.field")
        field.tap()
        field.typeText("First comment")
        element("comment.composer.send").tap()
        XCTAssertTrue(app.staticTexts["First comment"].waitForExistence(timeout: 10))

        element("post.\(id).react").tap()
        element("post.\(id).react.👍").tap()
        let chip = element("post.\(id).reaction.👍")
        XCTAssertTrue(chip.label.contains("1"))
        XCTAssertTrue(chip.label.contains("you reacted"))
        screenshot("04-post-detail")

        // Back in the feed the card shows the new comment count and reaction.
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(element("post.\(id).comments").label.contains("1 comment"))
        XCTAssertTrue(element("post.\(id).reaction.👍").exists)
    }

    func testPostsFromOthersAppearInRealTimeAndPageIn() async throws {
        let me = try await api.makeUser("reader")
        let other = try await api.makeUser("writer")
        var ids: [Int] = []
        for n in 1...24 { ids.append(try await api.createPost(other, "Older post \(n)")) }
        launch(as: me)
        openFeed()

        // The newest page is there; the oldest posts aren't yet.
        element("feed.post.\(ids.last!)")
        XCTAssertFalse(app.descendants(matching: .any)["feed.post.\(ids.first!)"].exists)

        // A post made elsewhere arrives without pulling to refresh.
        waitForRealtime()
        let live = try await api.createPost(other, "Posted while you watched")
        element("feed.post.\(live)")
        screenshot("05-live-post")

        // Scrolling to the bottom pages the rest in.
        let list = element("feed.list")
        let oldest = app.descendants(matching: .any)["feed.post.\(ids.first!)"]
        var swipes = 0
        while !oldest.exists && swipes < 20 { list.swipeUp(); swipes += 1 }
        XCTAssertTrue(oldest.waitForExistence(timeout: 10), "older page never loaded")
    }

    func testMentionOpensTheProfile() async throws {
        let me = try await api.makeUser("viewer")
        let friend = try await api.makeUser("friend")
        let postId = try await api.createPost(me, "cc @\(friend.username) please look")
        launch(as: me)
        openFeed()
        element("feed.post.\(postId)")
        let link = app.links["@\(friend.username)"]
        XCTAssertTrue(link.waitForExistence(timeout: 10), "mention wasn't rendered as a link")
        screenshot("06-mention")
        link.tap()
        element("profile.screen")
        XCTAssertEqual(element("profile.username").label, "@\(friend.username)")
        screenshot("07-profile")
    }

    func testEditAndDeleteOwnPost() async throws {
        let me = try await api.makeUser("editor")
        let id = try await api.createPost(me, "Typo in this post")
        launch(as: me)
        openFeed()
        element("feed.post.\(id)")

        element("post.\(id).menu").tap()
        element("post.\(id).edit").tap()
        let text = app.textViews["composer.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        text.tap()
        text.press(forDuration: 1.0)
        app.menuItems["Select All"].firstMatch.tap()
        text.typeText("Fixed post")
        element("composer.submit").tap()
        XCTAssertTrue(app.staticTexts["Fixed post"].waitForExistence(timeout: 10))

        element("post.\(id).menu").tap()
        element("post.\(id).delete").tap()
        element("post.\(id).delete.confirm").tap()
        XCTAssertTrue(app.descendants(matching: .any)["feed.post.\(id)"].waitForNonExistence(timeout: 10))
        screenshot("08-after-delete")
    }

    func testOtherPeoplesPostsHaveNoEditControls() async throws {
        let me = try await api.makeUser("guest")
        let other = try await api.makeUser("host")
        let id = try await api.createPost(other, "Not yours")
        launch(as: me)
        openFeed()
        element("feed.post.\(id)")
        XCTAssertFalse(app.descendants(matching: .any)["post.\(id).menu"].exists)
    }

    func testPhotoPostShowsItsImage() async throws {
        let me = try await api.makeUser("photog")
        let id = try await api.createPhotoPost(me, caption: "pixel.png")
        launch(as: me)
        openFeed()
        element("feed.post.\(id)")
        element("post.\(id).attachment")
        screenshot("09-photo-post")
    }

    func testCommentThreadsExpandReplies() async throws {
        let me = try await api.makeUser("threader")
        let other = try await api.makeUser("replier")
        let postId = try await api.createPost(me, "Thread starter")
        let commentId = try await api.createComment(other, on: postId, "Top level")
        _ = try await api.request("POST", "/comments/\(commentId)/replies", body: ["content": "Nested reply"], token: me.accessToken)
        launch(as: me)
        openFeed()
        element("feed.post.\(postId)").tap()
        XCTAssertTrue(app.staticTexts["Top level"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Nested reply"].exists)
        element("comment.\(commentId).replies").tap()
        XCTAssertTrue(app.staticTexts["Nested reply"].waitForExistence(timeout: 10))
        screenshot("10-thread")
    }
}
