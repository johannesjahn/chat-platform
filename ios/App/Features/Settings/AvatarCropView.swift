import SwiftUI
import UIKit

/// Image preparation for avatar uploads.
enum AvatarImage {
    /// The longest side an upload is scaled down to — far above the 320px the
    /// server keeps, and keeps the body well under `UserLimits.maxAvatarBytes`.
    static let maxSide: CGFloat = 2048

    /// Redraws a photo upright (orientation baked into the pixels, scale 1)
    /// and no larger than `maxSide`, so crop coordinates mean the same thing
    /// to the server as they do here.
    static func upright(_ image: UIImage) -> UIImage {
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let factor = min(1, maxSide / max(pixels.width, pixels.height))
        let target = CGSize(width: (pixels.width * factor).rounded(), height: (pixels.height * factor).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    /// JPEG at decreasing quality until it fits the server's size cap.
    static func jpeg(_ image: UIImage) -> Data? {
        for quality in [0.9, 0.75, 0.6, 0.45] as [CGFloat] {
            if let data = image.jpegData(compressionQuality: quality), data.count <= UserLimits.maxAvatarBytes { return data }
        }
        return nil
    }
}

extension UIImage {
    var pixelSize: CGSize { CGSize(width: size.width * scale, height: size.height * scale) }
}

/// Pinch and drag a photo inside a circle, then upload that square.
struct AvatarCropView: View {
    struct Result {
        var jpeg: Data
        var region: AvatarCropGeometry.Region
    }

    let image: UIImage
    let onFinish: (Result?) -> Void

    @State private var geometry: AvatarCropGeometry?
    @State private var gestureZoom: CGFloat = 1
    @State private var gestureOffset: CGSize = .zero
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                GeometryReader { proxy in
                    let side = min(proxy.size.width, proxy.size.height)
                    cropArea(side: side)
                        .frame(width: side, height: side)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .onAppear { if geometry == nil { geometry = AvatarCropGeometry(imageSize: image.pixelSize, viewport: side) } }
                }
                .padding(.horizontal, 16)
                Text("Pinch to zoom, drag to move.").font(.footnote).foregroundStyle(.secondary)
                if let failure { ErrorBanner(message: failure, identifier: "avatarCrop.error").padding(.horizontal) }
            }
            .padding(.vertical)
            .navigationTitle("Move and scale")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onFinish(nil) }.accessibilityIdentifier("avatarCrop.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use photo") { finish() }.accessibilityIdentifier("avatarCrop.done")
                }
            }
        }
    }

    @ViewBuilder
    private func cropArea(side: CGFloat) -> some View {
        if let geometry {
            let live = livePreview(geometry)
            ZStack {
                Color.black
                Image(uiImage: image)
                    .resizable()
                    .frame(width: live.displayedSize.width, height: live.displayedSize.height)
                    .offset(live.offset)
                // Dim everything outside the circle the avatar will show.
                Rectangle().fill(.black.opacity(0.5))
                    .mask {
                        Rectangle().overlay { Circle().blendMode(.destinationOut) }.compositingGroup()
                    }
                Circle().stroke(.white.opacity(0.9), lineWidth: 1.5)
            }
            .clipped()
            .contentShape(Rectangle())
            .gesture(
                DragGesture()
                    .onChanged { gestureOffset = $0.translation }
                    .onEnded { _ in commit() }
                    .simultaneously(with: MagnifyGesture()
                        .onChanged { gestureZoom = $0.magnification }
                        .onEnded { _ in commit() })
            )
            .accessibilityElement()
            .accessibilityLabel("Photo crop")
            .accessibilityHint("Pinch to zoom, drag to move the photo.")
            .accessibilityAdjustableAction { direction in
                guard var next = self.geometry else { return }
                next.update(zoom: next.zoom * (direction == .increment ? 1.2 : 1 / 1.2), offset: next.offset)
                self.geometry = next
            }
            .accessibilityIdentifier("avatarCrop.area")
        }
    }

    private func livePreview(_ base: AvatarCropGeometry) -> AvatarCropGeometry {
        var live = base
        live.update(
            zoom: base.zoom * gestureZoom,
            offset: CGSize(width: base.offset.width + gestureOffset.width, height: base.offset.height + gestureOffset.height)
        )
        return live
    }

    private func commit() {
        guard let geometry else { return }
        self.geometry = livePreview(geometry)
        gestureZoom = 1
        gestureOffset = .zero
    }

    private func finish() {
        guard let geometry else { return }
        guard let jpeg = AvatarImage.jpeg(image) else {
            failure = "That photo is too large to upload."
            return
        }
        onFinish(Result(jpeg: jpeg, region: geometry.cropRegion))
    }
}
