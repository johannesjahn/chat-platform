import Foundation

// The settings forms as plain values: what's typed, what's wrong with it, and
// the exact request it becomes. Kept free of SwiftUI so they're unit-tested.

/// `PUT /users/me` — full-replace: `displayName` and `avatarUrl` are always
/// sent (`null` clears), `bio` is omitted to keep the stored one. The
/// generated client can't send these `null`s (it drops nil keys), so this is
/// encoded by hand and sent with `APIClient.sendJSON`.
struct UpdateProfileRequest: Encodable, Sendable, Equatable {
    enum Bio: Sendable, Equatable {
        case keep
        case set(String?)
    }

    var displayName: String?
    var avatarUrl: String?
    var bio: Bio = .keep

    private enum CodingKeys: String, CodingKey { case displayName, avatarUrl, bio }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let displayName { try container.encode(displayName, forKey: .displayName) } else { try container.encodeNil(forKey: .displayName) }
        if let avatarUrl { try container.encode(avatarUrl, forKey: .avatarUrl) } else { try container.encodeNil(forKey: .avatarUrl) }
        if case .set(let bio) = bio {
            if let bio { try container.encode(bio, forKey: .bio) } else { try container.encodeNil(forKey: .bio) }
        }
    }
}

/// `PUT /users/me/status` — full-replace too: both fields always sent (two
/// `null`s clear the status), `expiresInMinutes` only alongside a status.
struct UpdateStatusRequest: Encodable, Sendable, Equatable {
    var statusText: String?
    var statusEmoji: String?
    var expiresInMinutes: Int?

    static let clear = UpdateStatusRequest(statusText: nil, statusEmoji: nil, expiresInMinutes: nil)

    private enum CodingKeys: String, CodingKey { case statusText, statusEmoji, expiresInMinutes }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let statusText { try container.encode(statusText, forKey: .statusText) } else { try container.encodeNil(forKey: .statusText) }
        if let statusEmoji { try container.encode(statusEmoji, forKey: .statusEmoji) } else { try container.encodeNil(forKey: .statusEmoji) }
        try container.encodeIfPresent(expiresInMinutes, forKey: .expiresInMinutes)
    }
}

/// How long a new status lasts — the web's "Clear after" options.
enum StatusExpiry: String, CaseIterable, Identifiable, Sendable {
    case never, minutes30, hour1, hours4, hours24

    var id: String { rawValue }

    var minutes: Int? {
        switch self {
        case .never: nil
        case .minutes30: 30
        case .hour1: 60
        case .hours4: 240
        case .hours24: 1440
        }
    }

    var label: String {
        switch self {
        case .never: "Doesn't expire"
        case .minutes30: "30 minutes"
        case .hour1: "1 hour"
        case .hours4: "4 hours"
        case .hours24: "24 hours"
        }
    }
}

struct StatusDraft: Equatable, Sendable {
    var emoji = ""
    var text = ""
    var expiry: StatusExpiry = .never

    var hasContent: Bool { !emoji.trimmed.isEmpty || !text.trimmed.isEmpty }

    /// What "Save" sends; nil when there's nothing to save (use `.clear`).
    var saveRequest: UpdateStatusRequest? {
        guard hasContent else { return nil }
        let text = text.trimmed.clamped(toJSLength: UserLimits.maxStatusText)
        let emoji = emoji.trimmed.clamped(toJSLength: UserLimits.maxStatusEmoji)
        return UpdateStatusRequest(
            statusText: text.isEmpty ? nil : text,
            statusEmoji: emoji.isEmpty ? nil : emoji,
            expiresInMinutes: expiry.minutes
        )
    }
}

struct ProfileDraft: Equatable, Sendable {
    var displayName = ""
    var bio = ""

    var problem: String? {
        if displayName.trimmed.jsLength > UserLimits.maxDisplayName {
            return "Display name can be at most \(UserLimits.maxDisplayName) characters."
        }
        if bio.trimmed.jsLength > UserLimits.maxBio { return "Bio can be at most \(UserLimits.maxBio) characters." }
        return nil
    }

    /// The save request. `avatarUrl` is the linked avatar URL to keep (the
    /// server clears an *uploaded* avatar on every profile save — that's its
    /// rule, shared with the web app).
    func request(keepingAvatarUrl avatarUrl: String?, bioLoaded: Bool) -> UpdateProfileRequest {
        let name = displayName.trimmed
        let bio = bio.trimmed
        return UpdateProfileRequest(
            displayName: name.isEmpty ? nil : name,
            avatarUrl: avatarUrl,
            bio: bioLoaded ? .set(bio.isEmpty ? nil : bio) : .keep
        )
    }
}

struct PasswordDraft: Equatable, Sendable {
    var current = ""
    var new = ""
    var confirm = ""

    var problem: String? {
        if !new.isEmpty, new.jsLength < UserLimits.minPassword {
            return "New password must be at least \(UserLimits.minPassword) characters."
        }
        if !confirm.isEmpty, new != confirm { return "New passwords don't match." }
        return nil
    }

    var canSubmit: Bool { !current.isEmpty && !new.isEmpty && !confirm.isEmpty && problem == nil }
}
