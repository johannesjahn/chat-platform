import Foundation

/// Where the backend lives. Resolved once at launch, in priority order:
/// the `-apiBaseURL <url>` launch argument, the `APIBaseURL` Info.plist value,
/// then `http://localhost:3000` (the simulator talking to a local backend).
struct AppConfig: Sendable, Equatable {
    static let fallbackBaseURL = URL(string: "http://localhost:3000")!

    let apiBaseURL: URL

    static func resolve(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        infoDictionary: [String: Any]? = Bundle.main.infoDictionary
    ) -> AppConfig {
        if let index = arguments.firstIndex(of: "-apiBaseURL"),
           arguments.indices.contains(index + 1),
           let url = parse(arguments[index + 1]) {
            return AppConfig(apiBaseURL: url)
        }
        if let plist = infoDictionary?["APIBaseURL"] as? String, let url = parse(plist) {
            return AppConfig(apiBaseURL: url)
        }
        return AppConfig(apiBaseURL: fallbackBaseURL)
    }

    /// Accepts only absolute http(s) URLs; a trailing slash is dropped so
    /// paths append cleanly.
    static func parse(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host() != nil
        else { return nil }
        return url
    }
}

/// Launch flags that only the UI tests use.
struct LaunchOptions: Sendable {
    /// `-uiTesting`: start from a signed-out Keychain and skip animations.
    let uiTesting: Bool
    /// `-uiTestSession <json>`: a session to start signed in with.
    let injectedSession: Data?
    /// `-uiAppearance dark|light`: pins the color scheme for screenshots.
    let appearance: String?

    static func resolve(arguments: [String] = ProcessInfo.processInfo.arguments) -> LaunchOptions {
        var injected: Data?
        if let index = arguments.firstIndex(of: "-uiTestSession"), arguments.indices.contains(index + 1) {
            injected = arguments[index + 1].data(using: .utf8)
        }
        var appearance: String?
        if let index = arguments.firstIndex(of: "-uiAppearance"), arguments.indices.contains(index + 1) {
            appearance = arguments[index + 1]
        }
        return LaunchOptions(uiTesting: arguments.contains("-uiTesting"), injectedSession: injected, appearance: appearance)
    }

    /// True while hosting the unit-test bundle: the app shouldn't boot its UI.
    static var isRunningUnitTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            && !ProcessInfo.processInfo.arguments.contains("-uiTesting")
    }
}
