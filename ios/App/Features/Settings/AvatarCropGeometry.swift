import CoreGraphics
import Foundation

/// The square avatar crop: an image (in pixels, already upright) shown in a
/// square viewport (points), zoomed and panned by the user. `cropRegion` is
/// what `POST /users/me/avatar` wants — `x`, `y`, `size` in the image's own
/// pixel coordinates (the server re-validates it against the decoded image).
struct AvatarCropGeometry: Equatable, Sendable {
    let imageSize: CGSize
    let viewport: CGFloat
    private(set) var zoom: CGFloat = 1
    /// The image's center relative to the viewport's, in points.
    private(set) var offset: CGSize = .zero

    struct Region: Equatable, Sendable {
        var x: Int
        var y: Int
        var size: Int
    }

    init(imageSize: CGSize, viewport: CGFloat) {
        self.imageSize = imageSize
        self.viewport = viewport
    }

    private var shortSide: CGFloat { min(imageSize.width, imageSize.height) }

    /// Points per pixel at zoom 1: the short side exactly fills the viewport.
    var baseScale: CGFloat { shortSide > 0 ? viewport / shortSide : 1 }
    var scale: CGFloat { baseScale * zoom }
    var displayedSize: CGSize { CGSize(width: imageSize.width * scale, height: imageSize.height * scale) }

    /// Up to 4×, but never so far that the crop drops below 64 pixels.
    var maxZoom: CGFloat { max(1, min(4, shortSide / 64)) }

    /// Whether the source is big enough for the server (`MIN_AVATAR_SOURCE_PX`).
    var isLargeEnough: Bool {
        imageSize.width >= CGFloat(UserLimits.minAvatarSourcePx) && imageSize.height >= CGFloat(UserLimits.minAvatarSourcePx)
    }

    /// Sets zoom and pan, keeping the viewport covered by the image.
    mutating func update(zoom newZoom: CGFloat, offset newOffset: CGSize) {
        zoom = min(max(newZoom, 1), maxZoom)
        let size = displayedSize
        let maxX = max(0, (size.width - viewport) / 2)
        let maxY = max(0, (size.height - viewport) / 2)
        offset = CGSize(width: min(max(newOffset.width, -maxX), maxX), height: min(max(newOffset.height, -maxY), maxY))
    }

    var cropRegion: Region {
        let side = min(viewport / scale, shortSide)
        let size = max(1, Int(side.rounded(.down)))
        let left = imageSize.width / 2 - (viewport / 2 + offset.width) / scale
        let top = imageSize.height / 2 - (viewport / 2 + offset.height) / scale
        let maxX = max(0, Int(imageSize.width) - size)
        let maxY = max(0, Int(imageSize.height) - size)
        return Region(
            x: min(max(Int(left.rounded()), 0), maxX),
            y: min(max(Int(top.rounded()), 0), maxY),
            size: size
        )
    }
}
