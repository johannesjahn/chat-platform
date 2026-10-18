import CoreGraphics
import SwiftUI

/// Sketchy's canvas format (web/src/lib/games/drawing.ts): strokes on a fixed
/// 800×600 virtual canvas, colors as indexes into a fixed palette, two brush
/// sizes. The palette must stay exactly `DRAWING_PALETTE_SIZE` (src/Api.ts)
/// long and in the web's order — an index means the same color on every
/// client, and every stored drawing depends on it (a unit test checks both
/// against the web and server sources).
enum Sketch {
    static let width = 800
    static let height = 600
    static let maxPoints = 6000
    static let maxStrokes = 400
    static let maxBluffLength = 60
    /// Consecutive points closer than this (canvas units) add nothing a
    /// viewer could see.
    static let minPointGap: Double = 3

    struct PaletteColor: Sendable {
        let name: String
        let hex: String
        var color: Color {
            let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
            return Color(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
        }
    }

    static let palette: [PaletteColor] = [
        PaletteColor(name: "Ink", hex: "#1d1b26"),
        PaletteColor(name: "Chalk", hex: "#ffffff"),
        PaletteColor(name: "Cherry", hex: "#ef4444"),
        PaletteColor(name: "Tangerine", hex: "#f97316"),
        PaletteColor(name: "Sunshine", hex: "#facc15"),
        PaletteColor(name: "Leaf", hex: "#22c55e"),
        PaletteColor(name: "Sky", hex: "#3b82f6"),
        PaletteColor(name: "Grape", hex: "#a855f7"),
        PaletteColor(name: "Bubblegum", hex: "#ec4899"),
        PaletteColor(name: "Cocoa", hex: "#8b5a2b"),
    ]

    static func brushWidth(_ brush: DrawingBrush) -> Double {
        switch brush {
        case .thin: 7
        case .thick: 20
        }
    }

    /// The paper every drawing sits on — always light, in either theme,
    /// because a drawing is a picture, not UI chrome.
    static let paper = Color(red: 1, green: 0.992, blue: 0.965)

    static func pointCount(_ strokes: [DrawingStroke]) -> Int {
        strokes.reduce(0) { $0 + $1.points.count / 2 }
    }

    /// A point on screen (within a canvas of `size`) in canvas units,
    /// clamped to the canvas.
    static func canvasPoint(_ location: CGPoint, in size: CGSize) -> (x: Int, y: Int) {
        guard size.width > 0, size.height > 0 else { return (0, 0) }
        let x = Double(location.x / size.width) * Double(width)
        let y = Double(location.y / size.height) * Double(height)
        return (Int(min(max(x, 0), Double(width)).rounded()), Int(min(max(y, 0), Double(height)).rounded()))
    }

    /// Appends a point to a flat `[x0, y0, x1, y1, …]` list unless it's too
    /// close to the last one to matter. Returns whether it was kept.
    @discardableResult
    static func append(_ point: (x: Int, y: Int), to points: inout [Int]) -> Bool {
        if points.count >= 2 {
            let dx = Double(point.x - points[points.count - 2])
            let dy = Double(point.y - points[points.count - 1])
            if (dx * dx + dy * dy).squareRoot() < minPointGap { return false }
        }
        points.append(point.x)
        points.append(point.y)
        return true
    }

    /// A stroke as a smooth path in a canvas of `size`: a quadratic curve
    /// through the midpoints of consecutive points (`strokePath` on the web).
    static func path(_ points: [Int], in size: CGSize) -> Path {
        let scaleX = size.width / CGFloat(width)
        let scaleY = size.height / CGFloat(height)
        let count = points.count / 2
        func point(_ index: Int) -> CGPoint {
            CGPoint(x: CGFloat(points[index * 2]) * scaleX, y: CGFloat(points[index * 2 + 1]) * scaleY)
        }
        var path = Path()
        guard count > 0 else { return path }
        path.move(to: point(0))
        if count == 1 {
            path.addLine(to: point(0))
            return path
        }
        if count == 2 {
            path.addLine(to: point(1))
            return path
        }
        for index in 1..<(count - 1) {
            let current = point(index)
            let next = point(index + 1)
            path.addQuadCurve(to: CGPoint(x: (current.x + next.x) / 2, y: (current.y + next.y) / 2), control: current)
        }
        path.addLine(to: point(count - 1))
        return path
    }
}
