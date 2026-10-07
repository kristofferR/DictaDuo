// Canonical Core Graphics renderer for the portable DictaDuo icon model.
// scripts/generate-brand.mjs includes this source in the app and CLI exports.
import Foundation
import CoreGraphics

enum BrandIconRenderer {
    struct Model: Codable, Sendable {
        let canvas: Double
        let paths: [String: [Command]]
        let paints: [String: Paint]
        let layers: [Layer]
    }

    struct Command: Codable, Sendable {
        let op: String
        let values: [Double]
    }

    struct Paint: Codable, Sendable {
        let kind: String
        let color: String?
        let opacity: Double?
        let from: [Double]?
        let to: [Double]?
        let center: [Double]?
        let radius: Double?
        let stops: [Stop]?
    }

    struct Stop: Codable, Sendable {
        let offset: Double
        let color: String
        let opacity: Double?
    }

    struct Layer: Codable, Sendable {
        let path: String
        let paint: String
        let mode: String
        let width: Double?
        let offset: [Double]?
        let clip: String?
    }

    enum RenderError: Error, CustomStringConvertible {
        case invalid(String)

        var description: String {
            switch self {
            case .invalid(let reason): "Invalid DictaDuo icon model: \(reason)"
            }
        }
    }

    private enum LayerMode: String {
        case fill, stroke, fillStroke
    }

    private enum PreparedPaint {
        case solid(CGColor)
        case linear(CGGradient, CGPoint, CGPoint)
        case radial(CGGradient, CGPoint, CGFloat)

        func draw(in context: CGContext) {
            switch self {
            case .solid(let color):
                context.setFillColor(color)
                context.fill(context.boundingBoxOfClipPath)
            case .linear(let gradient, let from, let to):
                context.drawLinearGradient(gradient, start: from, end: to,
                                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            case .radial(let gradient, let center, let radius):
                context.drawRadialGradient(gradient, startCenter: center, startRadius: 0,
                                           endCenter: center, endRadius: radius,
                                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }
        }
    }

    private struct PreparedLayer {
        let path: CGPath
        let paint: PreparedPaint
        let mode: LayerMode
        let width: CGFloat
        let offset: CGPoint
        let clip: CGPath?
    }

    /// The caller supplies a y-down context. A square canvas is fitted uniformly
    /// and centered in rect. Layer offsets move geometry, paint, and its clip
    /// together. Paint coordinates are absolute canvas coordinates, not bounds.
    static func draw(_ model: Model, in rect: CGRect, context: CGContext) throws {
        guard model.canvas.isFinite, model.canvas > 0 else {
            throw RenderError.invalid("canvas must be a finite positive number")
        }
        guard [rect.minX, rect.minY, rect.width, rect.height].allSatisfy({ $0.isFinite }),
              rect.width > 0, rect.height > 0 else {
            throw RenderError.invalid("destination rectangle must be finite and nonempty")
        }
        guard !model.paths.isEmpty, !model.paints.isEmpty, !model.layers.isEmpty else {
            throw RenderError.invalid("paths, paints, and layers must be present")
        }
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            throw RenderError.invalid("sRGB color space is unavailable")
        }

        // Preflight every resource and reference before changing the destination.
        var paths: [String: CGPath] = [:]
        for (name, commands) in model.paths {
            paths[name] = try makePath(commands, named: name)
        }
        var paints: [String: PreparedPaint] = [:]
        for (name, paint) in model.paints {
            paints[name] = try prepare(paint, named: name, colorSpace: colorSpace)
        }
        let layers = try model.layers.enumerated().map { index, layer -> PreparedLayer in
            guard let path = paths[layer.path] else {
                throw RenderError.invalid("layer \(index) refers to unknown path \(layer.path)")
            }
            guard let paint = paints[layer.paint] else {
                throw RenderError.invalid("layer \(index) refers to unknown paint \(layer.paint)")
            }
            guard let mode = LayerMode(rawValue: layer.mode) else {
                throw RenderError.invalid("layer \(index) has unsupported mode \(layer.mode)")
            }
            let width = layer.width ?? 1
            guard width.isFinite, width > 0 else {
                throw RenderError.invalid("layer \(index) stroke width must be finite and positive")
            }
            let offset = try point(layer.offset ?? [0, 0], named: "layer \(index) offset")
            let clip: CGPath?
            if let name = layer.clip {
                guard let clipPath = paths[name] else {
                    throw RenderError.invalid("layer \(index) refers to unknown clip \(name)")
                }
                clip = clipPath
            } else {
                clip = nil
            }
            return PreparedLayer(path: path, paint: paint, mode: mode,
                                 width: CGFloat(width), offset: offset, clip: clip)
        }
        let scale = min(rect.width, rect.height) / CGFloat(model.canvas)
        let origin = CGPoint(x: rect.minX + (rect.width - CGFloat(model.canvas) * scale) / 2,
                             y: rect.minY + (rect.height - CGFloat(model.canvas) * scale) / 2)
        guard scale.isFinite, scale > 0, origin.x.isFinite, origin.y.isFinite else {
            throw RenderError.invalid("destination scale is invalid")
        }

        context.saveGState()
        defer { context.restoreGState() }
        context.clip(to: rect)
        context.translateBy(x: origin.x, y: origin.y)
        context.scaleBy(x: scale, y: scale)
        context.clip(to: CGRect(x: 0, y: 0, width: CGFloat(model.canvas), height: CGFloat(model.canvas)))
        context.setShouldAntialias(true)
        context.setBlendMode(.normal)
        context.setAlpha(1)
        context.setShadow(offset: .zero, blur: 0, color: nil)
        for layer in layers { draw(layer, in: context) }
    }

    private static func draw(_ layer: PreparedLayer, in context: CGContext) {
        context.saveGState()
        defer { context.restoreGState() }
        context.translateBy(x: layer.offset.x, y: layer.offset.y)
        if let clip = layer.clip {
            context.beginPath()
            context.addPath(clip)
            context.clip()
        }
        // As in SVG, fillStroke paints the fill first and then the stroke.
        if layer.mode != .stroke { paint(layer, stroke: false, in: context) }
        if layer.mode != .fill { paint(layer, stroke: true, in: context) }
    }

    private static func paint(_ layer: PreparedLayer, stroke: Bool, in context: CGContext) {
        context.saveGState()
        defer { context.restoreGState() }
        context.beginPath()
        context.addPath(layer.path)
        if stroke {
            context.setLineWidth(layer.width)
            context.setLineCap(.round)
            context.setLineJoin(.round)
            context.setLineDash(phase: 0, lengths: [])
            context.replacePathWithStrokedPath()
        }
        context.clip()
        layer.paint.draw(in: context)
    }

    private static func makePath(_ commands: [Command], named name: String) throws -> CGPath {
        guard !commands.isEmpty else { throw RenderError.invalid("path \(name) is empty") }
        let path = CGMutablePath()
        var hasMove = false
        for (index, command) in commands.enumerated() {
            let values = command.values
            guard values.allSatisfy({ $0.isFinite }) else {
                throw RenderError.invalid("path \(name), command \(index), has nonfinite coordinates")
            }
            guard command.op == "M" || hasMove else {
                throw RenderError.invalid("path \(name) must begin with M")
            }
            func point(_ index: Int) -> CGPoint {
                CGPoint(x: CGFloat(values[index]), y: CGFloat(values[index + 1]))
            }
            switch (command.op, values.count) {
            case ("M", 2):
                path.move(to: point(0))
                hasMove = true
            case ("L", 2): path.addLine(to: point(0))
            case ("C", 6): path.addCurve(to: point(4), control1: point(0), control2: point(2))
            case ("Q", 4): path.addQuadCurve(to: point(2), control: point(0))
            case ("Z", 0): path.closeSubpath()
            default:
                throw RenderError.invalid("path \(name), command \(index), has unsupported \(command.op)/\(values.count) operands")
            }
        }
        return path
    }

    private static func prepare(_ paint: Paint, named name: String,
                                colorSpace: CGColorSpace) throws -> PreparedPaint {
        let alpha = try opacity(paint.opacity, named: "paint \(name)")
        if paint.kind == "solid" {
            guard let source = paint.color else { throw RenderError.invalid("solid paint \(name) needs a color") }
            return .solid(try color(source, opacity: alpha, colorSpace: colorSpace))
        }
        guard paint.kind == "linear" || paint.kind == "radial" else {
            throw RenderError.invalid("paint \(name) has unsupported kind \(paint.kind)")
        }
        guard let stops = paint.stops, stops.count >= 2 else {
            throw RenderError.invalid("gradient \(name) needs at least two stops")
        }
        var colors: [CGColor] = []
        var locations: [CGFloat] = []
        var previous = -Double.infinity
        for stop in stops {
            guard stop.offset.isFinite, (0...1).contains(stop.offset), stop.offset >= previous else {
                throw RenderError.invalid("gradient \(name) offsets must be ordered between zero and one")
            }
            previous = stop.offset
            let stopAlpha = try opacity(stop.opacity, named: "gradient \(name) stop")
            colors.append(try color(stop.color, opacity: alpha * stopAlpha, colorSpace: colorSpace))
            locations.append(CGFloat(stop.offset))
        }
        guard let gradient = CGGradient(colorsSpace: colorSpace, colors: colors as CFArray, locations: locations) else {
            throw RenderError.invalid("could not create gradient \(name)")
        }
        if paint.kind == "linear" {
            guard let from = paint.from, let to = paint.to else {
                throw RenderError.invalid("linear gradient \(name) needs from and to points")
            }
            let start = try point(from, named: "gradient \(name) from")
            let end = try point(to, named: "gradient \(name) to")
            guard start != end else { throw RenderError.invalid("linear gradient \(name) has no length") }
            return .linear(gradient, start, end)
        }
        guard let center = paint.center, let radius = paint.radius, radius.isFinite, radius > 0 else {
            throw RenderError.invalid("radial gradient \(name) needs a center and finite positive radius")
        }
        return .radial(gradient, try point(center, named: "gradient \(name) center"), CGFloat(radius))
    }

    private static func point(_ values: [Double], named name: String) throws -> CGPoint {
        guard values.count == 2, values.allSatisfy({ $0.isFinite }) else {
            throw RenderError.invalid("\(name) needs two finite coordinates")
        }
        return CGPoint(x: CGFloat(values[0]), y: CGFloat(values[1]))
    }

    private static func opacity(_ value: Double?, named name: String) throws -> CGFloat {
        let alpha = value ?? 1
        guard alpha.isFinite, (0...1).contains(alpha) else {
            throw RenderError.invalid("\(name) opacity must be between zero and one")
        }
        return CGFloat(alpha)
    }

    private static func color(_ source: String, opacity: CGFloat,
                              colorSpace: CGColorSpace) throws -> CGColor {
        guard source.first == "#", source.count == 7 || source.count == 9,
              source.dropFirst().allSatisfy({ "0123456789abcdefABCDEF".contains($0) }),
              let value = UInt32(source.dropFirst(), radix: 16) else {
            throw RenderError.invalid("color \(source) must be #RRGGBB or #RRGGBBAA")
        }
        let rgba = source.count == 9
        let rgb = rgba ? value >> 8 : value
        let alpha = (rgba ? CGFloat(value & 0xFF) / 255 : 1) * opacity
        guard let color = CGColor(colorSpace: colorSpace,
                                  components: [CGFloat((rgb >> 16) & 0xFF) / 255,
                                               CGFloat((rgb >> 8) & 0xFF) / 255,
                                               CGFloat(rgb & 0xFF) / 255, alpha]) else {
            throw RenderError.invalid("could not create sRGB color \(source)")
        }
        return color
    }
}
