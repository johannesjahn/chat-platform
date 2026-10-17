import XCTest

final class ChatsTests: AppTestCase {
    func testDirectChatMessagesArriveLiveAndShowTyping() async throws {
        let me = try await api.makeUser("alice")
        let friend = try await api.makeUser("bob")
        launch(as: me)
        openChats()
        screenshot("chats-01-list")

        // Start the chat from the UI: search for the friend, tap them.
        element("chats.new").tap()
        let search = element("newChat.search")
        search.tap()
        search.typeText(friend.username)
        element("newChat.user.\(friend.id)").tap()
        element("chat.composer.field")
        element("chat.empty")
        screenshot("chats-02-new-direct")

        type(intoComposer: "Hello from the iPhone")
        sendComposer()
        waitForText("Hello from the iPhone")
        let friendsChats = try await api.chatDetailsList(friend)
        let chatId = try XCTUnwrap(friendsChats.first)
        var mine: Int?
        try await eventually { mine = try await api.messageId(friend, in: chatId, text: "Hello from the iPhone"); return mine != nil }

        // The other side, through the API: it arrives without pulling to refresh.
        waitForRealtime()
        try await api.typing(friend, in: chatId)
        let typing = element("chat.typing", timeout: 4)
        XCTAssertTrue(typing.label.contains("is typing"), typing.label)
        screenshot("chats-03-typing")
        let reply = try await api.send(friend, to: chatId, "Hi back from the API")
        element("message.\(reply)")
        waitForText("Hi back from the API")
        // Their message clears the typing indicator straight away.
        XCTAssertTrue(app.descendants(matching: .any)["chat.typing"].waitForNonExistence(timeout: 3))

        // My message reads as read once they've marked it.
        if let mine {
            _ = try await api.chat("POST", "/chats/\(chatId)/read", body: ["messageId": reply], as: friend)
            let read = element("message.\(mine).read")
            let isRead = NSPredicate(format: "label == 'Read'")
            XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: isRead, object: read)], timeout: 10), .completed)
        }
        screenshot("chats-04-conversation")
    }

    func testUnreadCountsShowAndClearOnOpen() async throws {
        let me = try await api.makeUser("reader")
        let friend = try await api.makeUser("sender")
        let chatId = try await api.directChat(friend, with: me)
        for n in 1...3 { try await api.send(friend, to: chatId, "Unread \(n)") }
        launch(as: me)
        openChats()
        let row = element("chat.row.\(chatId)")
        XCTAssertTrue(row.label.contains("3 unread"), row.label)
        let tab = app.tabBars.buttons["Chats"]
        XCTAssertTrue((tab.value as? String)?.contains("3") == true, "badge: \(String(describing: tab.value))")
        screenshot("chats-05-unread")

        row.tap()
        waitForText("Unread 3")
        try await eventually { (try await api.chatDetail(me, chatId)["unreadCount"] as? Int) == 0 }
        app.navigationBars.buttons.firstMatch.tap()
        let cleared = NSPredicate(format: "NOT (label CONTAINS 'unread')")
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: cleared, object: element("chat.row.\(chatId)"))], timeout: 10), .completed)

        // A new message while on the list bumps it live.
        waitForRealtime()
        try await api.send(friend, to: chatId, "One more")
        let one = NSPredicate(format: "label CONTAINS '1 unread'")
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: one, object: element("chat.row.\(chatId)"))], timeout: 10), .completed)
        screenshot("chats-06-live-unread")
    }

    func testReplyReactPinStarEditAndDelete() async throws {
        let me = try await api.makeUser("actor")
        let friend = try await api.makeUser("buddy")
        let chatId = try await api.directChat(friend, with: me)
        let theirs = try await api.send(friend, to: chatId, "Pick a restaurant")
        launch(as: me)
        openChat(chatId)
        element("message.\(theirs)")

        // Reply.
        messageAction(theirs, "Reply")
        element("chat.composer.context")
        type(intoComposer: "Tacos?")
        sendComposer()
        var reply = 0
        try await eventually { reply = try await api.messageId(me, in: chatId, text: "Tacos?") ?? 0; return reply != 0 }
        let parent = element("message.\(reply).parent")
        XCTAssertTrue(parent.label.contains("Pick a restaurant"), parent.label)
        screenshot("chats-07-reply")

        // React.
        messageAction(theirs, "React")
        app.buttons["👍"].firstMatch.tap()
        let chip = element("message.\(theirs).reaction.👍")
        XCTAssertTrue(chip.label.contains("you reacted"))

        // Pin → the pinned bar; star → the starred list.
        messageAction(theirs, "Pin")
        let bar = element("chat.pinnedBar")
        XCTAssertTrue(bar.label.contains("Pick a restaurant"), bar.label)
        element("message.\(theirs).pinned")
        screenshot("chats-08-pinned")
        messageAction(theirs, "Star")
        element("message.\(theirs).starred")
        element("chat.menu").tap()
        element("chat.menu.stars").tap()
        element("stars.row.\(theirs)")
        screenshot("chats-09-starred")
        element("pins.done").tap()
        messageAction(theirs, "Unpin")
        XCTAssertTrue(app.descendants(matching: .any)["chat.pinnedBar"].waitForNonExistence(timeout: 10))

        // Edit my reply.
        messageAction(reply, "Edit")
        let field = element("chat.composer.field")
        field.press(forDuration: 1.0)
        app.menuItems["Select All"].firstMatch.tap()
        field.typeText("Burritos?")
        sendComposer()
        waitForText("Burritos?")
        element("message.\(reply).edited")
        screenshot("chats-10-edited")

        // Delete it.
        messageAction(reply, "Delete")
        element("message.delete.confirm").tap()
        XCTAssertTrue(app.descendants(matching: .any)["message.\(reply)"].waitForNonExistence(timeout: 10))
        try await eventually { try await api.messageId(me, in: chatId, text: "Burritos?") == nil }
    }

    func testForwardingToAnotherChat() async throws {
        let me = try await api.makeUser("fwd")
        let friend = try await api.makeUser("origin")
        let other = try await api.makeUser("target")
        let source = try await api.directChat(friend, with: me)
        let target = try await api.groupChat(me, title: "Forward target \(UUID().uuidString.prefix(4))", members: [other])
        let original = try await api.send(friend, to: source, "Worth sharing")
        launch(as: me)
        openChat(source)
        messageAction(original, "Forward")
        element("forward.chat.\(target)").tap()
        screenshot("chats-11-forward-pick")
        element("forward.send").tap()
        let result = element("forward.result.\(target)")
        XCTAssertTrue(result.label.contains("Sent"), result.label)
        screenshot("chats-12-forward-result")
        element("forward.cancel").tap()

        var copy = 0
        try await eventually { copy = try await api.messageId(other, in: target, text: "Worth sharing") ?? 0; return copy != 0 }
        app.navigationBars.buttons.firstMatch.tap()
        openChat(target)
        let label = element("message.\(copy).forwarded")
        XCTAssertTrue(label.label.contains(friend.username), label.label)
    }

    func testImageAttachmentsRender() async throws {
        let me = try await api.makeUser("viewer")
        let friend = try await api.makeUser("photog")
        let chatId = try await api.directChat(friend, with: me)
        let image = try await api.sendImage(friend, to: chatId)
        launch(as: me)
        openChat(chatId)
        element("message.\(image).attachment")
        screenshot("chats-13-image")

        // Sending one from the photo library.
        element("chat.composer.attach").tap()
        element("chat.composer.attach.photo").tap()
        let photo = app.images.matching(NSPredicate(format: "identifier BEGINSWITH 'PXGGridLayout' OR label CONTAINS 'Photo'")).firstMatch
        if photo.waitForExistence(timeout: 10) {
            photo.tap()
            element("chat.composer.attachment")
            screenshot("chats-14-picked-photo")
            sendComposer()
            try await eventually(timeout: 20) {
                try await api.messages(me, in: chatId).contains { ($0["contentType"] as? String) == "attachment" && ($0["senderId"] as? Int) == me.id }
            }
        } else {
            screenshot("chats-14-photo-picker")
            XCTFail("The photo picker showed no photos")
        }
    }

    func testGroupManagementAndInviteLinks() async throws {
        let me = try await api.makeUser("owner")
        let first = try await api.makeUser("member")
        let second = try await api.makeUser("extra")
        let joiner = try await api.makeUser("joiner")
        let title = "Team \(UUID().uuidString.prefix(4))"
        launch(as: me)
        openChats()

        // Create the group in the UI.
        element("chats.new").tap()
        element("newChat.kind").buttons["Group"].tap()
        let name = element("newChat.title")
        name.tap()
        name.typeText(title)
        let search = element("newChat.search")
        search.tap()
        search.typeText(first.username)
        element("newChat.user.\(first.id)").tap()
        element("newChat.selected.\(first.id)")
        screenshot("chats-15-new-group")
        element("newChat.create").tap()
        element("chat.composer.field")
        var chatId = 0
        try await eventually { chatId = try await api.chatDetailsList(me).first ?? 0; return chatId != 0 }

        // Info: add a member, promote, rename, remove.
        element("chat.title").tap()
        element("chatInfo.addMembers").tap()
        let add = element("addMembers.search")
        add.tap()
        add.typeText(second.username)
        element("addMembers.user.\(second.id)").tap()
        element("addMembers.add").tap()
        element("chatInfo.member.\(second.id)")

        element("chatInfo.member.\(first.id).menu").tap()
        app.buttons["Make admin"].firstMatch.tap()
        XCTAssertEqual(element("chatInfo.member.\(first.id).role").label, "Admin")

        element("chatInfo.rename").tap()
        let rename = element("chatInfo.rename.field")
        rename.tap()
        rename.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: title.count + 2) + "Renamed \(title)")
        element("chatInfo.rename.save").tap()
        XCTAssertTrue(element("chatInfo.name").label.hasPrefix("Renamed"))

        element("chatInfo.member.\(second.id).menu").tap()
        app.buttons["Remove from group"].firstMatch.tap()
        element("chatInfo.confirm").tap()
        XCTAssertTrue(app.descendants(matching: .any)["chatInfo.member.\(second.id)"].waitForNonExistence(timeout: 10))
        screenshot("chats-16-group-info")

        // Invite link: create it here, redeem it as a third user via the API.
        scrollTo("chatInfo.invite.create", in: "chatInfo.list").tap()
        let code = app.descendants(matching: .any).matching(NSPredicate(format: "identifier ENDSWITH '.code' AND identifier BEGINSWITH 'chatInfo.invite.'")).firstMatch
        XCTAssertTrue(code.waitForExistence(timeout: 10))
        screenshot("chats-17-invite")
        waitForRealtime()
        _ = try await api.join(joiner, code: code.label)
        // The member list updates live (the chat's version moves).
        element("chatInfo.member.\(joiner.id)", timeout: 15)
        let detail = try await api.chatDetail(me, chatId)
        XCTAssertEqual((detail["participants"] as? [[String: Any]])?.count, 3)

        // Leave: the conversation closes and the chat is gone from the list.
        scrollTo("chatInfo.leave", in: "chatInfo.list").tap()
        element("chatInfo.confirm").tap()
        element("chats.list")
        XCTAssertTrue(app.descendants(matching: .any)["chat.row.\(chatId)"].waitForNonExistence(timeout: 10))
        let remaining = try await api.chatDetail(first, chatId)
        XCTAssertFalse((remaining["participants"] as? [[String: Any]] ?? []).contains { ($0["userId"] as? Int) == me.id })
    }

    func testJoiningWithAnInviteCode() async throws {
        let owner = try await api.makeUser("host")
        let me = try await api.makeUser("guest")
        let chatId = try await api.groupChat(owner, title: "Open house", members: [try await api.makeUser("filler")])
        let code = try await api.createInvite(owner, for: chatId)
        try await api.send(owner, to: chatId, "Welcome in")
        launch(as: me)
        openChats()
        element("chats.join").tap()
        let field = element("join.code")
        field.tap()
        field.typeText("https://chat.example.com/chats/join/\(code)")
        screenshot("chats-18-join")
        element("join.submit").tap()
        waitForText("Welcome in")
        let detail = try await api.chatDetail(me, chatId)
        XCTAssertTrue((detail["participants"] as? [[String: Any]] ?? []).contains { ($0["userId"] as? Int) == me.id })
    }

    func testScrollingUpPagesInOlderMessages() async throws {
        let me = try await api.makeUser("scroller")
        let friend = try await api.makeUser("chatty")
        let chatId = try await api.directChat(friend, with: me)
        var ids: [Int] = []
        for n in 1...64 { ids.append(try await api.send(friend, to: chatId, "Line \(n)")) }
        launch(as: me)
        openChat(chatId)
        // Opens on the newest; the oldest isn't loaded yet.
        element("message.\(ids.last!)")
        XCTAssertFalse(app.descendants(matching: .any)["message.\(ids.first!)"].exists)
        screenshot("chats-19-newest")

        let thread = element("chat.thread")
        let oldest = app.descendants(matching: .any)["message.\(ids.first!)"]
        var swipes = 0
        while !oldest.exists && swipes < 40 { thread.swipeDown(velocity: .fast); swipes += 1 }
        XCTAssertTrue(oldest.waitForExistence(timeout: 10), "older pages never loaded")
        element("chat.beginning")
        screenshot("chats-20-oldest")
    }

    func testDeletedChatShowsNotFound() async throws {
        let owner = try await api.makeUser("admin")
        let me = try await api.makeUser("member")
        let chatId = try await api.groupChat(owner, title: "Short-lived", members: [me])
        try await api.send(owner, to: chatId, "This group is ending")
        launch(as: me)
        openChat(chatId)
        waitForRealtime()
        try await api.chat("DELETE", "/chats/\(chatId)", as: owner)
        element("chat.missing")
        screenshot("chats-21-missing")
    }
}

extension TestAPI {
    /// The ids of `user`'s chats, newest activity first.
    func chatDetailsList(_ user: TestUser) async throws -> [Int] {
        let page = try await chat("GET", "/chats", as: user) as! [String: Any]
        return (page["chats"] as! [[String: Any]]).map { $0["id"] as! Int }
    }
}
