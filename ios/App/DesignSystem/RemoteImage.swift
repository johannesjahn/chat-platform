import SwiftUI

/// An image from a server URL, cached by `ImageLoader`, with a neutral
/// placeholder while it loads (or if it can't).
struct RemoteImage: View {
    @Environment(AppEnvironment.self) private var env
    let urlString: String
    var contentMode: ContentMode = .fill
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            Color(.secondarySystemFill)
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else if failed {
                Image(systemName: "photo").foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isImage)
        // Lets a UI test tell a rendered picture from a placeholder.
        .accessibilityValue(image != nil ? "loaded" : failed ? "failed" : "loading")
        .task(id: urlString) {
            image = env.images.cached(urlString)
            guard image == nil else { return }
            image = await env.images.load(urlString)
            failed = image == nil
        }
    }
}

/// A user's picture: their avatar when they have one, else a colored circle
/// with their initial. An optional dot shows presence.
struct AvatarView: View {
    @Environment(AppEnvironment.self) private var env
    let userId: Int?
    var size: CGFloat = 40
    var showsPresence = false
    /// When set, the picture is exposed to accessibility under this id (its
    /// value says whether a photo loaded); otherwise it's decorative.
    var identifier: String?

    private static let palette: [Color] = [.blue, .indigo, .purple, .pink, .orange, .teal, .green, .red]

    /// The smallest uploaded variant that stays sharp at this size on a 3× screen.
    private func avatarURL(_ user: User?) -> String? {
        guard let user else { return nil }
        if let variants = user.avatarVariants {
            return size <= 32 ? variants.small : size <= 64 ? variants.medium : variants.large
        }
        return user.avatarUrl
    }

    var body: some View {
        let user = userId.flatMap { env.users.user($0) }
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let url = avatarURL(user) {
                    RemoteImage(urlString: url)
                        .accessibilityLabel("Profile photo")
                        .accessibilityIdentifier(identifier.map { "\($0).photo" } ?? "")
                } else {
                    ZStack {
                        Rectangle().fill(Self.palette[abs(userId ?? 0) % Self.palette.count].gradient)
                        Text(String((user?.shownName.first ?? "?")).uppercased())
                            .font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(.white)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("No profile photo")
                    .accessibilityIdentifier(identifier.map { "\($0).initials" } ?? "")
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            if showsPresence, let userId, env.users.isOnline(userId) {
                Circle().fill(.green).frame(width: size * 0.28, height: size * 0.28)
                    .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
            }
        }
        .accessibilityHidden(identifier == nil)
    }
}
