// Native macOS PNG/iconset export. scripts/generate-brand.mjs prepends the
// canonical Resources/Brand/native-renderer.swift to produce make-icon.swift.
// After editing the source artwork, run: node scripts/generate-brand.mjs
import AppKit

private struct IconExportDocument: Decodable {
    let render: BrandIconRenderer.Model
}

private enum IconExportError: Error, CustomStringConvertible {
    case invalid(String)

    var description: String {
        switch self {
        case .invalid(let message): message
        }
    }
}

private func makeIcon(pixels: Int, model: BrandIconRenderer.Model) throws -> Data {
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: pixels, height: pixels,
                                  bitsPerComponent: 8, bytesPerRow: pixels * 4,
                                  space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw IconExportError.invalid("Could not create a \(pixels)-pixel sRGB icon canvas")
    }
    let rect = CGRect(x: 0, y: 0, width: CGFloat(pixels), height: CGFloat(pixels))
    context.clear(rect)
    context.translateBy(x: 0, y: CGFloat(pixels))
    context.scaleBy(x: 1, y: -1)
    try BrandIconRenderer.draw(model, in: rect, context: context)
    guard let image = context.makeImage(),
          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw IconExportError.invalid("Could not encode a \(pixels)-pixel icon")
    }
    return png
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("Usage: swift scripts/make-icon.swift OUTPUT.iconset\n".utf8))
    exit(2)
}

do {
    let projectRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
    let source = projectRoot.appendingPathComponent("Resources/Brand/generated/drawing.json")
    let artwork = try JSONDecoder().decode(IconExportDocument.self, from: Data(contentsOf: source))
    let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    for size in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let suffix = scale == 2 ? "@2x" : ""
            let name = "icon_\(size)x\(size)\(suffix).png"
            try makeIcon(pixels: size * scale, model: artwork.render)
                .write(to: output.appendingPathComponent(name), options: .atomic)
        }
    }
    print("Generated DictaDuo Inkflow Graphite iconset: \(output.path)")
} catch {
    FileHandle.standardError.write(Data("DictaDuo icon export failed: \(error)\n".utf8))
    exit(1)
}
