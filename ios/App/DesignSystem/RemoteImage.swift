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

    private static let palette: [Color] = [.blue, .indigo, .purple, .pink, .orange, .teal, .green, .red]

    var body: some View {
        let user = userId.flatMap { env.users.user($0) }
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let url = user?.avatarVariants?.small ?? user?.avatarUrl {
                    RemoteImage(urlString: url)
                } else {
                    ZStack {
                        Rectangle().fill(Self.palette[abs(userId ?? 0) % Self.palette.count].gradient)
                        Text(String((user?.shownName.first ?? "?")).uppercased())
                            .font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(.white)
                    }
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            if showsPresence, let userId, env.users.isOnline(userId) {
                Circle().fill(.green).frame(width: size * 0.28, height: size * 0.28)
                    .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
            }
        }
        .accessibilityHidden(true)
    }
}
