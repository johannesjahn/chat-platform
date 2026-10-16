import SwiftUI

/// The three typing dots in a bubble — the web app's brand mark.
struct BrandMark: View {
    var size: CGFloat = 56

    var body: some View {
        Image(systemName: "bubble.left.fill")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(.tint)
            .overlay {
                HStack(spacing: size * 0.08) {
                    ForEach(0..<3, id: \.self) { _ in
                        Circle().fill(Color(.systemBackground)).frame(width: size * 0.1, height: size * 0.1)
                    }
                }
                .offset(y: -size * 0.04)
            }
            .accessibilityHidden(true)
    }
}

/// An inline error with an optional retry.
struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)?
    var identifier: String = "error.banner"

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            Text(message).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Retry", action: retry).font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("\(identifier).retry")
            }
        }
        .padding(12)
        .background(Color.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: retry == nil ? .combine : .contain)
        .accessibilityIdentifier(identifier)
    }
}

/// Full-screen state for a list that's empty or failed to load.
struct EmptyState: View {
    let title: String
    let systemImage: String
    var message: String?
    var identifier: String = "empty"
    var action: (title: String, run: () -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            if let message { Text(message) }
        } actions: {
            if let action {
                Button(action.title, action: action.run).buttonStyle(.primary)
                    .accessibilityIdentifier("\(identifier).action")
            }
        }
        .accessibilityIdentifier(identifier)
    }
}

/// How a loadable resource is doing, for views that show skeleton / empty /
/// error states instead of blocking on the network.
enum LoadPhase: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)
}

/// A filled button in the accent color, with a label that stays readable on
/// it in both themes (navy in light mode, amber in dark — plain white would
/// wash out on the amber).
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(isEnabled ? Color("OnAccent") : Color.secondary)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(isEnabled ? Color.accentColor.opacity(configuration.isPressed ? 0.8 : 1) : Color(.tertiarySystemFill), in: Capsule())
            .contentShape(Capsule())
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { PrimaryButtonStyle() }
}
