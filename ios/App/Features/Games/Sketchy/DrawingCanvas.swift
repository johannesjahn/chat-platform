import SwiftUI

/// A drawing, rendered from its strokes at any size on the always-light paper.
struct DrawingView: View {
    let strokes: [DrawingStroke]
    var label = "Drawing"
    var identifier = "sketchy.drawing"

    var body: some View {
        Canvas { context, size in
            for stroke in strokes { draw(stroke, in: &context, size: size) }
        }
        .aspectRatio(CGFloat(Sketch.width) / CGFloat(Sketch.height), contentMode: .fit)
        .background(Sketch.paper, in: RoundedRectangle(cornerRadius: 14))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(.separator), lineWidth: 1))
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isImage)
        .accessibilityIdentifier(identifier)
    }
}

func draw(_ stroke: DrawingStroke, in context: inout GraphicsContext, size: CGSize) {
    let color = Sketch.palette.indices.contains(stroke.color) ? Sketch.palette[stroke.color].color : .black
    let width = Sketch.brushWidth(stroke.brush) * size.width / CGFloat(Sketch.width)
    context.stroke(Sketch.path(stroke.points, in: size), with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
}

/// Sketchy's drawing surface: a finger draws strokes in canvas units (thinned
/// as they're recorded), with the fixed palette, two brushes, undo and clear.
struct SketchCanvas: View {
    @Binding var strokes: [DrawingStroke]
    var disabled = false
    @State private var color = 0
    @State private var brush: DrawingBrush = .thin
    @State private var current: [Int] = []

    private var budgetLeft: Bool {
        strokes.count < Sketch.maxStrokes && Sketch.pointCount(strokes) + current.count / 2 < Sketch.maxPoints
    }

    var body: some View {
        VStack(spacing: 10) {
            GeometryReader { proxy in
                Canvas { context, size in
                    for stroke in strokes { draw(stroke, in: &context, size: size) }
                    if !current.isEmpty {
                        draw(DrawingStroke(color: color, brush: brush, points: current), in: &context, size: size)
                    }
                }
                .background(Sketch.paper)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            guard !disabled, budgetLeft else { return }
                            Sketch.append(Sketch.canvasPoint(value.location, in: proxy.size), to: &current)
                        }
                        .onEnded { _ in commit() }
                )
            }
            .aspectRatio(CGFloat(Sketch.width) / CGFloat(Sketch.height), contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(.separator), lineWidth: 1))
            .accessibilityElement()
            .accessibilityLabel("Drawing canvas, \(strokes.count) strokes")
            .accessibilityAddTraits(.allowsDirectInteraction)
            .accessibilityIdentifier("sketchy.canvas")
            .accessibilityValue("\(strokes.count)")

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(Sketch.palette.enumerated()), id: \.offset) { index, entry in
                        Button { color = index } label: {
                            Circle().fill(entry.color).frame(width: 30, height: 30)
                                .overlay(Circle().stroke(Color(.separator), lineWidth: 1))
                                .overlay(Circle().stroke(Color.primary, lineWidth: color == index ? 3 : 0).padding(-4))
                                .padding(4)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(entry.name)
                        .accessibilityAddTraits(color == index ? .isSelected : [])
                        .accessibilityIdentifier("sketchy.color.\(index)")
                    }
                }
                .padding(.horizontal, 4)
            }
            HStack(spacing: 10) {
                Picker("Brush", selection: $brush) {
                    Text("Thin").tag(DrawingBrush.thin)
                    Text("Thick").tag(DrawingBrush.thick)
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 160)
                .accessibilityIdentifier("sketchy.brush")
                Spacer()
                Button { _ = strokes.popLast() } label: { Image(systemName: "arrow.uturn.backward") }
                    .disabled(strokes.isEmpty || disabled)
                    .accessibilityLabel("Undo")
                    .accessibilityIdentifier("sketchy.undo")
                Button(role: .destructive) { strokes = [] } label: { Image(systemName: "trash") }
                    .disabled(strokes.isEmpty || disabled)
                    .accessibilityLabel("Clear")
                    .accessibilityIdentifier("sketchy.clear")
            }
            .buttonStyle(.bordered)
        }
    }

    /// Ends the stroke in progress (a pen lift, or time running out).
    private func commit() {
        guard !current.isEmpty else { return }
        strokes.append(DrawingStroke(color: color, brush: brush, points: current))
        current = []
    }
}
