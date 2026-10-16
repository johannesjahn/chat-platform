import Foundation
import Security
import Synchronization

/// A single secret blob (the signed-in session). The Keychain in the app, an
/// in-memory box in tests.
protocol SecretStorage: Sendable {
    func read() -> Data?
    func write(_ data: Data)
    func delete()
}

struct KeychainStorage: SecretStorage {
    let service: String
    let account: String

    init(service: String = "dev.chatplatform.ios", account: String = "session") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func read() -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    func write(_ data: Data) {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
    }

    func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

final class InMemoryStorage: SecretStorage {
    private let box = Mutex<Data?>(nil)
    init(_ initial: Data? = nil) { box.withLock { $0 = initial } }
    func read() -> Data? { box.withLock { $0 } }
    func write(_ data: Data) { box.withLock { $0 = data } }
    func delete() { box.withLock { $0 = nil } }
}
