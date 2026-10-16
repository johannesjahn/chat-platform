import Foundation
import XCTest

/// The backend test.sh started, passed in through `TEST_RUNNER_API_BASE_URL`.
enum TestEnvironment {
    static var baseURL: URL {
        let raw = ProcessInfo.processInfo.environment["API_BASE_URL"] ?? "http://localhost:3000"
        return URL(string: raw)!
    }

    /// `light` (default) or `dark`, from `TEST_RUNNER_UITEST_APPEARANCE`.
    static var appearance: String {
        ProcessInfo.processInfo.environment["UITEST_APPEARANCE"] ?? "light"
    }
}

/// A user created straight through the API — each test makes its own, so tests
/// never share state and can run in any order.
struct TestUser: Sendable {
    let id: Int
    let username: String
    let password: String
    let accessToken: String
    let refreshToken: String
    /// The JSON the app accepts through `-uiTestSession` to start signed in.
    let sessionJSON: String
}

struct TestAPIError: Error, CustomStringConvertible {
    let description: String
}

/// A minimal client for arranging test data. Deliberately independent of the
/// app's own networking code, so a bug there can't hide itself.
struct TestAPI: Sendable {
    let baseURL: URL

    init(baseURL: URL = TestEnvironment.baseURL) { self.baseURL = baseURL }

    @discardableResult
    func request(
        _ method: String, _ path: String, body: [String: Any]? = nil,
        token: String? = nil, from clientIP: String? = nil, expect: Range<Int> = 200..<300
    ) async throws -> Any {
        var request = URLRequest(url: URL(string: baseURL.absoluteString + path)!)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let clientIP { request.setValue(clientIP, forHTTPHeaderField: "X-Forwarded-For") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard expect.contains(status) else {
            throw TestAPIError(description: "\(method) \(path) → \(status): \(String(decoding: data, as: UTF8.self))")
        }
        return data.isEmpty ? [String: Any]() : (try JSONSerialization.jsonObject(with: data))
    }

    @discardableResult
    func createPost(_ user: TestUser, _ text: String) async throws -> Int {
        let post = try await request("POST", "/posts", body: ["contentType": "text", "content": text], token: user.accessToken) as! [String: Any]
        return post["id"] as! Int
    }

    @discardableResult
    func createComment(_ user: TestUser, on postId: Int, _ text: String) async throws -> Int {
        let comment = try await request("POST", "/posts/\(postId)/comments", body: ["content": text], token: user.accessToken) as! [String: Any]
        return comment["id"] as! Int
    }

    /// Uploads a tiny PNG and makes it a post, as the app's own photo posts are.
    @discardableResult
    func createPhotoPost(_ user: TestUser, caption: String) async throws -> Int {
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
        let boundary = "b-\(UUID().uuidString)"
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"pixel.png\"\r\nContent-Type: image/png\r\n\r\n".utf8))
        body.append(png)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var upload = URLRequest(url: URL(string: baseURL.absoluteString + "/attachments")!)
        upload.httpMethod = "POST"
        upload.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        upload.setValue("Bearer \(user.accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.upload(for: upload, from: body)
        guard (response as? HTTPURLResponse)?.statusCode == 201 else { throw TestAPIError(description: "upload failed: \(String(decoding: data, as: UTF8.self))") }
        let attachment = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let post = try await request("POST", "/posts", body: ["contentType": "attachment", "content": caption, "attachmentId": attachment["id"] as! Int], token: user.accessToken) as! [String: Any]
        return post["id"] as! Int
    }

    /// A fresh account, unique per call.
    func makeUser(_ prefix: String = "user") async throws -> TestUser {
        let username = "\(prefix)_\(UUID().uuidString.prefix(8).lowercased())"
        let password = "password-\(UUID().uuidString.prefix(6))"
        // A made-up client address per user (the backend trusts X-Forwarded-For
        // from loopback in test.sh), so the per-IP register/login limits never bite.
        let ip = "10.\(Int.random(in: 1...254)).\(Int.random(in: 1...254)).\(Int.random(in: 1...254))"
        try await request("POST", "/users/register", body: ["username": username, "password": password], from: ip)
        let login = try await request("POST", "/users/login", body: ["username": username, "password": password], from: ip) as! [String: Any]
        let user = login["user"] as! [String: Any]
        let session = try JSONSerialization.data(withJSONObject: login)
        return TestUser(
            id: user["id"] as! Int, username: username, password: password,
            accessToken: login["accessToken"] as! String, refreshToken: login["refreshToken"] as! String,
            sessionJSON: String(decoding: session, as: UTF8.self)
        )
    }
}

/// Base class: launches the app against the test backend, signed out or as a
/// given user, and takes named screenshots (attached to the result bundle,
/// exported by test.sh).
@MainActor
class AppTestCase: XCTestCase {
    var app: XCUIApplication!
    let api = TestAPI()

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    func launch(as user: TestUser? = nil) {
        app.launchArguments = ["-uiTesting", "-apiBaseURL", TestEnvironment.baseURL.absoluteString]
        app.launchArguments += ["-uiAppearance", TestEnvironment.appearance]
        if let user { app.launchArguments += ["-uiTestSession", user.sessionJSON] }
        app.launch()
    }

    /// The system's "Save Password?" sheet (it belongs to another process, so
    /// an interruption monitor can't be relied on) follows a fresh sign-in.
    func dismissSavePasswordPrompt() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let notNow = springboard.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 4) {
            notNow.tap()
            _ = notNow.waitForNonExistence(timeout: 5)
        }
    }

    /// Taps a tab, retrying if the tap landed on something animating away.
    func selectTab(_ name: String) {
        let tab = app.tabBars.buttons[name]
        XCTAssertTrue(tab.waitForExistence(timeout: 10), "No “\(name)” tab")
        for _ in 0..<4 where !tab.isSelected {
            tab.tap()
            _ = NSPredicate(format: "isSelected == true").evaluate(with: tab)
            Thread.sleep(forTimeInterval: 0.6)
        }
    }

    /// Taps the Feed tab and waits for its list.
    func openFeed() {
        selectTab("Feed")
        element("feed.list")
    }

    /// Waits for the live socket, so a test about live updates can't race its start-up.
    func waitForRealtime() {
        let state = app.descendants(matching: .any)["realtime.state"]
        let connected = NSPredicate(format: "label == 'connected'")
        let result = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: connected, object: state)], timeout: 15)
        if result != .completed {
            screenshot("realtime-not-connected")
            XCTFail("The realtime socket never connected (state: \(state.exists ? state.label : "missing"))")
        }
    }

    func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "\(TestEnvironment.appearance)-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @discardableResult
    func element(_ id: String, timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let match = app.descendants(matching: .any).matching(identifier: id).firstMatch
        if !match.waitForExistence(timeout: timeout) {
            screenshot("missing-\(id)") // what the screen looked like instead
            XCTFail("Missing element “\(id)”", file: file, line: line)
        }
        return match
    }
}
