import Foundation
import XCTest

/// Chat helpers for arranging data through the API. Each call poses as a
/// fresh client address (see `TestAPI.makeUser`), so a burst of messages
/// never trips the per-IP request budget the app itself also draws on.
extension TestAPI {
    private var anyIP: String { "10.\(Int.random(in: 1...254)).\(Int.random(in: 1...254)).\(Int.random(in: 1...254))" }

    @discardableResult
    func chat(_ method: String, _ path: String, body: [String: Any]? = nil, as user: TestUser) async throws -> Any {
        try await request(method, path, body: body, token: user.accessToken, from: anyIP)
    }

    func directChat(_ user: TestUser, with other: TestUser) async throws -> Int {
        let chat = try await chat("POST", "/chats/direct", body: ["userId": other.id], as: user) as! [String: Any]
        return chat["id"] as! Int
    }

    func groupChat(_ owner: TestUser, title: String, members: [TestUser]) async throws -> Int {
        let chat = try await chat("POST", "/chats/group", body: ["title": title, "participantIds": members.map(\.id)], as: owner) as! [String: Any]
        return chat["id"] as! Int
    }

    @discardableResult
    func send(_ user: TestUser, to chatId: Int, _ text: String, replyTo parent: Int? = nil) async throws -> Int {
        var body: [String: Any] = ["contentType": "text", "content": text]
        if let parent { body["parentMessageId"] = parent }
        let message = try await chat("POST", "/chats/\(chatId)/messages", body: body, as: user) as! [String: Any]
        return message["id"] as! Int
    }

    /// Uploads a small PNG and sends it as an attachment message.
    @discardableResult
    func sendImage(_ user: TestUser, to chatId: Int) async throws -> Int {
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
        let boundary = "b-\(UUID().uuidString)"
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"red.png\"\r\nContent-Type: image/png\r\n\r\n".utf8))
        body.append(png)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var upload = URLRequest(url: URL(string: baseURL.absoluteString + "/attachments")!)
        upload.httpMethod = "POST"
        upload.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        upload.setValue("Bearer \(user.accessToken)", forHTTPHeaderField: "Authorization")
        upload.setValue(anyIP, forHTTPHeaderField: "X-Forwarded-For")
        let (data, response) = try await URLSession.shared.upload(for: upload, from: body)
        guard (response as? HTTPURLResponse)?.statusCode == 201 else { throw TestAPIError(description: "upload failed: \(String(decoding: data, as: UTF8.self))") }
        let attachment = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let message = try await chat("POST", "/chats/\(chatId)/messages", body: ["contentType": "attachment", "content": "red.png", "attachmentId": attachment["id"] as! Int], as: user) as! [String: Any]
        return message["id"] as! Int
    }

    func typing(_ user: TestUser, in chatId: Int) async throws {
        try await chat("POST", "/chats/\(chatId)/typing", as: user)
    }

    /// The chat's newest messages as `user` sees them, oldest first.
    func messages(_ user: TestUser, in chatId: Int) async throws -> [[String: Any]] {
        let page = try await chat("GET", "/chats/\(chatId)/messages?limit=50", as: user) as! [String: Any]
        return page["messages"] as! [[String: Any]]
    }

    func messageId(_ user: TestUser, in chatId: Int, text: String) async throws -> Int? {
        try await messages(user, in: chatId).last { ($0["content"] as? String) == text }?["id"] as? Int
    }

    func chatDetail(_ user: TestUser, _ chatId: Int) async throws -> [String: Any] {
        try await chat("GET", "/chats/\(chatId)", as: user) as! [String: Any]
    }

    func createInvite(_ owner: TestUser, for chatId: Int) async throws -> String {
        let invite = try await chat("POST", "/chats/\(chatId)/invites", body: [:], as: owner) as! [String: Any]
        return invite["code"] as! String
    }

    func join(_ user: TestUser, code: String) async throws -> Int {
        let chat = try await chat("POST", "/chats/invites/\(code)/join", as: user) as! [String: Any]
        return chat["id"] as! Int
    }
}

extension AppTestCase {
    func openChats() {
        selectTab("Chats")
        element("chats.list")
    }

    /// Opens a conversation from the chat list.
    func openChat(_ chatId: Int) {
        openChats()
        let row = element("chat.row.\(chatId)")
        row.tap()
        element("chat.composer.field")
    }

    /// Long-presses a message and picks an item from its context menu.
    func messageAction(_ messageId: Int, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let bubble = element("message.\(messageId)", file: file, line: line)
        let text = app.descendants(matching: .any).matching(identifier: "message.\(messageId).text").firstMatch
        (text.exists ? text : bubble).press(forDuration: 1.0)
        let item = app.buttons[label].firstMatch
        if !item.waitForExistence(timeout: 5) {
            screenshot("missing-menu-\(label)")
            XCTFail("No “\(label)” in the message menu", file: file, line: line)
        }
        item.tap()
    }

    /// Swipes `container` up until `id` is on screen (lists build lazily).
    @discardableResult
    func scrollTo(_ id: String, in container: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let target = app.descendants(matching: .any).matching(identifier: id).firstMatch
        let list = element(container, file: file, line: line)
        var swipes = 0
        while !(target.exists && target.isHittable) && swipes < 8 { list.swipeUp(); swipes += 1 }
        if !target.isHittable {
            screenshot("missing-\(id)")
            XCTFail("Couldn't scroll to “\(id)”", file: file, line: line)
        }
        return target
    }

    func type(intoComposer text: String) {
        let field = element("chat.composer.field")
        field.tap()
        field.typeText(text)
    }

    func sendComposer() {
        element("chat.composer.send").tap()
    }

    /// Waits for a static text to appear anywhere.
    @discardableResult
    func waitForText(_ text: String, timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let match = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", text)).firstMatch
        if !match.waitForExistence(timeout: timeout) {
            screenshot("missing-text")
            XCTFail("Never saw “\(text)”", file: file, line: line)
        }
        return match
    }

    /// Polls an API-side condition (the backend is the source of truth).
    func eventually(timeout: TimeInterval = 10, _ check: () async throws -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if try await check() { return }
            try await Task.sleep(for: .milliseconds(300))
        }
        XCTFail("Condition never held", file: file, line: line)
    }
}
