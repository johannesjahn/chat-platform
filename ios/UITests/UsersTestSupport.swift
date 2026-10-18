import Foundation
import UIKit
import XCTest

/// Arranging people, profiles and admins through the API.
extension TestAPI {
    private static func clientIP() -> String {
        "10.\(Int.random(in: 1...254)).\(Int.random(in: 1...254)).\(Int.random(in: 1...254))"
    }

    /// Signs in again (a role change revokes every earlier token).
    func login(username: String, password: String) async throws -> TestUser {
        let login = try await request("POST", "/users/login", body: ["username": username, "password": password], from: Self.clientIP()) as! [String: Any]
        let user = login["user"] as! [String: Any]
        let session = try JSONSerialization.data(withJSONObject: login)
        return TestUser(
            id: user["id"] as! Int, username: username, password: password,
            accessToken: login["accessToken"] as! String, refreshToken: login["refreshToken"] as! String,
            sessionJSON: String(decoding: session, as: UTF8.self)
        )
    }

    /// The admin test.sh seeded (nothing in the API can mint one).
    func seededAdmin() async throws -> TestUser {
        let env = ProcessInfo.processInfo.environment
        guard let username = env["ADMIN_USERNAME"], let password = env["ADMIN_PASSWORD"] else {
            throw TestAPIError(description: "No seeded admin — run the UI tests through ios/scripts/test.sh")
        }
        return try await login(username: username, password: password)
    }

    /// A fresh account promoted to admin, signed in again so its session has the role.
    func makeAdmin(_ prefix: String = "admin") async throws -> TestUser {
        let user = try await makeUser(prefix)
        let admin = try await seededAdmin()
        try await request("PATCH", "/users/\(user.id)/role", body: ["role": "admin"], token: admin.accessToken)
        return try await login(username: user.username, password: user.password)
    }

    func setProfile(_ user: TestUser, displayName: String?, bio: String?) async throws {
        try await request("PUT", "/users/me", body: ["displayName": displayName ?? NSNull(), "avatarUrl": NSNull(), "bio": bio ?? NSNull()], token: user.accessToken)
    }

    func setStatus(_ user: TestUser, emoji: String?, text: String?) async throws {
        try await request("PUT", "/users/me/status", body: ["statusEmoji": emoji ?? NSNull(), "statusText": text ?? NSNull()], token: user.accessToken)
    }

    /// Uploads a generated 300×300 picture (bold diagonal stripes) as the avatar.
    func uploadAvatar(_ user: TestUser) async throws {
        let size = CGSize(width: 300, height: 300)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let png = UIGraphicsImageRenderer(size: size, format: format).pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor.systemOrange.setFill()
            for offset in stride(from: -300, to: 300, by: 60) {
                let path = UIBezierPath()
                path.move(to: CGPoint(x: offset, y: 0))
                path.addLine(to: CGPoint(x: offset + 30, y: 0))
                path.addLine(to: CGPoint(x: offset + 330, y: 300))
                path.addLine(to: CGPoint(x: offset + 300, y: 300))
                path.close()
                path.fill()
            }
        }
        let boundary = "b-\(UUID().uuidString)"
        var body = Data()
        for (name, value) in [("x", "0"), ("y", "0"), ("size", "300")] {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"avatar.png\"\r\nContent-Type: image/png\r\n\r\n".utf8))
        body.append(png)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var upload = URLRequest(url: URL(string: baseURL.absoluteString + "/users/me/avatar")!)
        upload.httpMethod = "POST"
        upload.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        upload.setValue("Bearer \(user.accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.upload(for: upload, from: body)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw TestAPIError(description: "avatar upload failed: \(String(decoding: data, as: UTF8.self))")
        }
    }
}

extension AppTestCase {
    /// Opens a pushed screen from the More tab.
    func openFromMore(_ id: String) {
        selectTab("More")
        element(id).tap()
    }

    /// Back out of whatever the More tab has pushed (an active search takes
    /// a tap of its own), until its root list shows.
    func backToMoreRoot() {
        selectTab("More")
        let root = app.descendants(matching: .any)["more.settings"]
        for _ in 0..<6 where !root.waitForExistence(timeout: 1.5) {
            let back = app.navigationBars.buttons.firstMatch
            if back.exists { back.tap() }
        }
        XCTAssertTrue(root.waitForExistence(timeout: 5), "never got back to the More tab's root")
    }

    /// Replaces a text field's contents.
    func replaceText(in field: XCUIElement, with text: String) {
        field.tap()
        if let current = field.value as? String, !current.isEmpty, current != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
        }
        field.typeText(text)
    }

    /// Average brightness (0…1) of the app's current screenshot.
    func screenBrightness() -> CGFloat {
        let image = app.screenshot().image
        guard let cg = image.cgImage else { return 0 }
        let width = 24, height = 48
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        var total = 0
        for i in stride(from: 0, to: pixels.count, by: 4) { total += Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) }
        return CGFloat(total) / CGFloat(width * height * 3 * 255)
    }
}
