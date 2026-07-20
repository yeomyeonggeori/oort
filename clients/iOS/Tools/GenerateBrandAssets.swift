#!/usr/bin/env swift

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

private let canvasSize = 1_024

private struct Palette {
    let start: CGColor
    let end: CGColor
    let highlight: CGColor
    let monogram: CGColor
}

private enum BrandAppearance: String, CaseIterable {
    case standard = "AppIcon-1024.png"
    case dark = "AppIcon-1024-dark.png"
    case tinted = "AppIcon-1024-tinted.png"

    var palette: Palette {
        switch self {
        case .standard:
            Palette(
                start: .sRGB(0x2B, 0x4F, 0x6B),
                end: .sRGB(0x19, 0x4B, 0x3B),
                highlight: .sRGB(0x78, 0xAB, 0xCB, alpha: 0.16),
                monogram: .sRGB(0xFF, 0xFF, 0xFD)
            )
        case .dark:
            Palette(
                start: .sRGB(0x16, 0x2A, 0x3E),
                end: .sRGB(0x0D, 0x2F, 0x25),
                highlight: .sRGB(0x5E, 0x8B, 0xA7, alpha: 0.12),
                monogram: .sRGB(0xF8, 0xFA, 0xF7)
            )
        case .tinted:
            Palette(
                start: .sRGB(0x28, 0x2D, 0x32),
                end: .sRGB(0x12, 0x16, 0x19),
                highlight: .sRGB(0xFF, 0xFF, 0xFF, alpha: 0.10),
                monogram: .sRGB(0xF7, 0xF7, 0xF5)
            )
        }
    }
}

private extension CGColor {
    static func sRGB(_ red: Int, _ green: Int, _ blue: Int, alpha: CGFloat = 1) -> CGColor {
        CGColor(
            srgbRed: CGFloat(red) / 255,
            green: CGFloat(green) / 255,
            blue: CGFloat(blue) / 255,
            alpha: alpha
        )
    }
}

private enum BrandAssetError: Error {
    case couldNotCreateBitmap
    case couldNotCreateGradient
    case couldNotCreateImage
    case couldNotCreateDestination
    case couldNotWritePNG
    case generatedImageIsInvalid(String)
}

private func defaultOutputDirectory() -> URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("XcodeHost/Assets.xcassets/AppIcon.appiconset", isDirectory: true)
}

private func makeContext() throws -> CGContext {
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
              data: nil,
              width: canvasSize,
              height: canvasSize,
              bitsPerComponent: 8,
              bytesPerRow: canvasSize * 4,
              space: colorSpace,
              bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
                  | CGImageAlphaInfo.noneSkipLast.rawValue
          ) else {
        throw BrandAssetError.couldNotCreateBitmap
    }
    context.setShouldAntialias(true)
    context.interpolationQuality = .high
    return context
}

private func drawBackground(_ palette: Palette, in context: CGContext) throws {
    let bounds = CGRect(x: 0, y: 0, width: canvasSize, height: canvasSize)
    guard let gradient = CGGradient(
        colorsSpace: context.colorSpace,
        colors: [palette.start, palette.end] as CFArray,
        locations: [0, 1]
    ) else {
        throw BrandAssetError.couldNotCreateGradient
    }
    context.drawLinearGradient(
        gradient,
        start: CGPoint(x: 80, y: canvasSize - 72),
        end: CGPoint(x: canvasSize - 64, y: 40),
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
    )

    guard let highlight = CGGradient(
        colorsSpace: context.colorSpace,
        colors: [palette.highlight, CGColor.sRGB(0xFF, 0xFF, 0xFF, alpha: 0)] as CFArray,
        locations: [0, 1]
    ) else {
        throw BrandAssetError.couldNotCreateGradient
    }
    context.drawRadialGradient(
        highlight,
        startCenter: CGPoint(x: 220, y: 824),
        startRadius: 0,
        endCenter: CGPoint(x: 220, y: 824),
        endRadius: 720,
        options: [.drawsAfterEndLocation]
    )

    // An explicit opaque fill is not needed because the first gradient covers
    // the full canvas, but retain the bounds assertion close to the renderer.
    precondition(bounds.width == bounds.height)
}

private func drawMonogram(_ palette: Palette, in context: CGContext) {
    let font = CTFontCreateWithName("HelveticaNeue-Bold" as CFString, 594, nil)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): palette.monogram,
        NSAttributedString.Key(kCTKernAttributeName as String): -14,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: "m", attributes: attributes))
    let bounds = CTLineGetBoundsWithOptions(line, [.useGlyphPathBounds])
    let origin = CGPoint(
        x: (CGFloat(canvasSize) - bounds.width) / 2 - bounds.minX,
        y: (CGFloat(canvasSize) - bounds.height) / 2 - bounds.minY - 18
    )

    context.saveGState()
    context.setShadow(
        offset: CGSize(width: 0, height: -18),
        blur: 30,
        color: CGColor.sRGB(0, 0, 0, alpha: 0.22)
    )
    context.textPosition = origin
    CTLineDraw(line, context)
    context.restoreGState()
}

private func writePNG(_ image: CGImage, to outputURL: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(
        outputURL as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        throw BrandAssetError.couldNotCreateDestination
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw BrandAssetError.couldNotWritePNG
    }
}

private func verifyPNG(at url: URL) throws {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          image.width == canvasSize,
          image.height == canvasSize,
          image.colorSpace?.name == CGColorSpace.sRGB,
          image.alphaInfo == .noneSkipLast || image.alphaInfo == .none else {
        throw BrandAssetError.generatedImageIsInvalid(url.lastPathComponent)
    }
}

private func render(_ appearance: BrandAppearance, to outputDirectory: URL) throws {
    let context = try makeContext()
    try drawBackground(appearance.palette, in: context)
    drawMonogram(appearance.palette, in: context)
    guard let image = context.makeImage() else {
        throw BrandAssetError.couldNotCreateImage
    }

    let outputURL = outputDirectory.appendingPathComponent(appearance.rawValue)
    try writePNG(image, to: outputURL)
    try verifyPNG(at: outputURL)
    print("Generated \(appearance.rawValue) (\(canvasSize)x\(canvasSize), sRGB, opaque)")
}

let outputDirectory = CommandLine.arguments.dropFirst().first.map {
    URL(
        fileURLWithPath: $0,
        relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    ).standardizedFileURL
} ?? defaultOutputDirectory()

do {
    try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
    for appearance in BrandAppearance.allCases {
        try render(appearance, to: outputDirectory)
    }
} catch {
    FileHandle.standardError.write(Data("Failed to generate iOS brand assets: \(error)\n".utf8))
    exit(1)
}
