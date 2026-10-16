import Foundation
import UIKit

/// Loads and caches remote images. Attachment URLs are presigned and the
/// server mints a fresh signature on every read, so the cache is keyed by the
/// URL *without* its query — the same picture reached twice isn't fetched
/// twice (web/src/lib/stableAttachmentUrls.ts solves the same problem).
@MainActor
final class ImageLoader {
    private let session: URLSession
    private let baseURL: URL
    private let cache = NSCache<NSString, UIImage>()
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    init(session: URLSession, baseURL: URL) {
        self.session = session
        self.baseURL = baseURL
        cache.countLimit = 300
    }

    /// Turns a server-provided string (absolute, `data:`, or a path) into a URL.
    func resolve(_ string: String) -> URL? {
        if string.hasPrefix("/") { return URL(string: string, relativeTo: baseURL)?.absoluteURL }
        return URL(string: string)
    }

    private func key(_ url: URL) -> String {
        if url.scheme == "data" { return String(url.absoluteString.prefix(200)) + "#\(url.absoluteString.count)" }
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        parts?.query = nil
        return parts?.string ?? url.absoluteString
    }

    func cached(_ string: String) -> UIImage? {
        guard let url = resolve(string) else { return nil }
        return cache.object(forKey: key(url) as NSString)
    }

    func load(_ string: String) async -> UIImage? {
        guard let url = resolve(string) else { return nil }
        let key = key(url)
        if let hit = cache.object(forKey: key as NSString) { return hit }
        if let task = inFlight[key] { return await task.value }
        let session = session
        let task = Task<UIImage?, Never> {
            guard let (data, response) = try? await session.data(from: url),
                  (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true
            else { return nil }
            return UIImage(data: data)
        }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil
        if let image { cache.setObject(image, forKey: key as NSString) }
        return image
    }
}
