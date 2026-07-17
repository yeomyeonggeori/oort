#!/usr/bin/env swift

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

private let canvasSize = 1_024
private let background = CGColor(
    srgbRed: 32.0 / 255.0,
    green: 36.0 / 255.0,
    blue: 40.0 / 255.0,
    alpha: 1
)
private let monogram = CGColor(
    srgbRed: 244.0 / 255.0,
    green: 244.0 / 255.0,
    blue: 242.0 / 255.0,
    alpha: 1
)

private func defaultOutputURL() -> URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("clients/iOS/XcodeHost/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png")
}

private func renderIcon(to outputURL: URL) throws {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
        | CGImageAlphaInfo.noneSkipLast.rawValue
    guard let context = CGContext(
        data: nil,
        width: canvasSize,
        height: canvasSize,
        bitsPerComponent: 8,
        bytesPerRow: canvasSize * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        throw IconError.couldNotCreateContext
    }

    context.setFillColor(background)
    context.fill(CGRect(x: 0, y: 0, width: canvasSize, height: canvasSize))

    guard let font = CTFontCreateUIFontForLanguage(.system, 540, nil) else {
        throw IconError.couldNotCreateFont
    }
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): monogram,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: "m", attributes: attributes))
    let bounds = CTLineGetBoundsWithOptions(line, [.useGlyphPathBounds])
    let x = (CGFloat(canvasSize) - bounds.width) / 2 - bounds.minX
    let y = (CGFloat(canvasSize) - bounds.height) / 2 - bounds.minY - 16
    context.textPosition = CGPoint(x: x, y: y)
    CTLineDraw(line, context)

    guard let image = context.makeImage() else {
        throw IconError.couldNotCreateImage
    }
    try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    guard let destination = CGImageDestinationCreateWithURL(
        outputURL as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        throw IconError.couldNotCreateDestination
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw IconError.couldNotWritePNG
    }
}

private enum IconError: Error {
    case couldNotCreateContext
    case couldNotCreateFont
    case couldNotCreateImage
    case couldNotCreateDestination
    case couldNotWritePNG
}

let outputURL = CommandLine.arguments.dropFirst().first.map {
    URL(fileURLWithPath: $0, relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
        .standardizedFileURL
} ?? defaultOutputURL()

do {
    try renderIcon(to: outputURL)
    print("Generated \(canvasSize)x\(canvasSize) iOS app icon at \(outputURL.path)")
} catch {
    FileHandle.standardError.write(Data("Failed to generate iOS app icon: \(error)\n".utf8))
    exit(1)
}
