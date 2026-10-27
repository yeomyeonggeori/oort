// =============================================================================
// The App Group "presentation" state: what lets the notification extension dress a push as a
// communication notification (sender's round photo, small app icon) without asking the network
// for everything (#4316, ADR-0204 증보 5).
//
// ## ONE file, TWO compilers
//
// This file is compiled twice, from this one source, and nothing here may depend on anything that
// only one of the two sees:
//
//   * the app, as part of the `MomoPushNative` pod (the CocoaPods glob in the podspec), where the
//     JS side writes into it (`exportAvatar`, `exportChannels`, `setPresentationSettings`,
//     `clearPresentation` in `MomoPushNativeModule.swift`);
//   * the notification extension, by file reference in `MomoMobile.xcodeproj` (`ios/MomoPushKit` is
//     the extension's own directory, but the layout this file defines has to be written and read by
//     the SAME code or the two halves drift — which here is silent: a drift is a missing photo).
//
// Foundation, CoreGraphics, CoreText, ImageIO and CryptoKit only. No UIKit and no Intents, so the
// `sim-check` next to this module compiles it on a Mac and runs every decision in it.
//
// ## What lives in the container
//
//   <App Group container>/
//     push-presentation-settings.json     the two switches (survives a sign-out: a preference of THIS PHONE)
//     push-presentation-cleanup-pending   a marker: a sign-out asked the system to forget our donations
//     push-presentation/                  the cache, gone on sign-out and when 「보낸 사람 표시」 goes off
//       avatars/<member>.<version>.png    ≤ 64 KB, ≤ 288 px, one file per (server, workspace, member, v)
//       channels/<scope>.json             channel id → kind, name (a push carries ids only)
//
// Why files, not `UserDefaults(suiteName:)`: with a missing App Group entitlement
// `UserDefaults(suiteName:)` still answers, from a private per-app plist the other process never
// sees. `containerURL(forSecurityApplicationGroupIdentifier:)` answers nil instead, so a broken
// entitlement is a visible "no container", not two processes quietly disagreeing about a switch.
//
// Why the cache holds channel names at all: the extension's credential is a push-fetch token that
// may read the roster and ONE channel's messages and nothing else (`push_fetch_route_allowed`,
// ADR-0188 §8.7). It cannot list channels, so the only place a channel's name can come from is the
// app, which already knows it and writes it here.
//
// Adapted from block/buzz `mobile/ios/BuzzPushKit/Sources/BuzzPushKit/` @ af5bb0a
// (https://github.com/block/buzz, Apache-2.0, Copyright 2026 Block, Inc.): the retry rule of
// `BuzzInteractionCleanupRetry.swift` and the timeout of `BuzzInteractionDeletionDeadline.swift`
// (`MomoPushPresentationCleanup` below), and the idea and the 64 KB PNG ceiling of
// `BuzzPushPresentationCache.swift` (`MomoPushPresentationCache`).
// Changed by oort (Apache-2.0 §4(b)):
//   · kept: a marker is written BEFORE the system is asked to delete the donated interactions and
//     removed only after it answered, so a deletion that never finished is retried at the next app
//     start; one completion per request, with a deadline; the PNG ceiling of 64 KB for a face.
//   · changed: no cross-process file lock (one marker, one acknowledgement that removes it only when no
//     newer request replaced it); no snapshot document and no relay-event verification — oort reads
//     REST, so a face is one file named by a digest of (server, workspace, member) and the media
//     version, channels are one small JSON per workspace; limits (256 entries, 4 MB, 30 days) are
//     oort's; the avatar is cut to a centred square of at most 288 px before it is stored.
//   · added: a default face drawn with CoreGraphics/CoreText from the phone's own avatar rule, and the
//     two switches of 설정 › 알림.
// =============================================================================
import CoreGraphics
import CoreText
import CryptoKit
import Foundation
import ImageIO

public enum MomoPushPresentationContract {
    /// Same string as `MomoPushContract.appGroupIdentifier` (the extension's kit) and the
    /// `com.apple.security.application-groups` entry of both entitlement files; `sim-check` compares
    /// the first two, `pushContract.test.ts` the last.
    public static let appGroupIdentifier = "group.app.momo.ios"

    public static let settingsFileName = "push-presentation-settings.json"
    public static let cleanupMarkerFileName = "push-presentation-cleanup-pending"
    public static let cacheDirectoryName = "push-presentation"
    public static let avatarsDirectoryName = "avatars"
    public static let channelsDirectoryName = "channels"

    /// A lock-screen avatar is drawn at ~40 pt; 96 pt @3x is the ceiling the design set (#4316 설계 2).
    public static let avatarMaxPixels = 288
    public static let avatarMaxBytes = 64 * 1024
    public static let avatarMaxEntries = 256
    public static let avatarMaxTotalBytes = 4 * 1024 * 1024
    public static let avatarTimeToLive: TimeInterval = 30 * 24 * 60 * 60

    /// A file the extension may take from the network (second photo source): the design's 256 KB / 3 s.
    public static let remoteAvatarMaxBytes = 256 * 1024
    public static let remoteAvatarTimeout: TimeInterval = 3
    /// The longest edge of a source picture the extension will decode. Extensions have ~24 MB: a PNG
    /// stores its pixels fully decoded, so a tiny file with huge dimensions must not be opened at all.
    public static let extensionSourceMaxEdge = 2048
    /// The app has the memory to open a bigger picture before it cuts it down.
    public static let appSourceMaxEdge = 4096
    public static let appSourceMaxBytes = 6 * 1024 * 1024

    public static let channelMaxEntries = 512
    public static let channelFileMaxBytes = 256 * 1024
    public static let channelTimeToLive: TimeInterval = 14 * 24 * 60 * 60
    public static let nameMaxCharacters = 80
}

// MARK: - the container

/// The shared directory every file below lives in. `nil` from `appGroup()` means the entitlement is
/// not granted to this binary: callers fall back to the notification's plain look rather than guess.
public struct MomoPushPresentationContainer: Sendable, Equatable {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    public static func appGroup(
        identifier: String = MomoPushPresentationContract.appGroupIdentifier
    ) -> MomoPushPresentationContainer? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
            .map(MomoPushPresentationContainer.init(url:))
    }

    public var settingsURL: URL {
        url.appendingPathComponent(MomoPushPresentationContract.settingsFileName)
    }

    public var cleanupMarkerURL: URL {
        url.appendingPathComponent(MomoPushPresentationContract.cleanupMarkerFileName)
    }

    public var cache: MomoPushPresentationCache {
        MomoPushPresentationCache(
            rootURL: url.appendingPathComponent(MomoPushPresentationContract.cacheDirectoryName, isDirectory: true))
    }
}

// MARK: - the two switches

/// 「메시지 미리보기」 and 「보낸 사람 표시」 of this phone (설정 › 알림). Both default to on: a phone that
/// never touched them has no file, and the extension reads that as `standard`.
public struct MomoPushPresentationSettings: Equatable, Sendable, Codable {
    /// Off: the body of a message notification is 「새 메시지」 (the name and the photo stay).
    public var previewEnabled: Bool
    /// Off: no communication notification and nothing donated; a message notification is 「oort / 새 메시지」.
    public var showSender: Bool

    public init(previewEnabled: Bool, showSender: Bool) {
        self.previewEnabled = previewEnabled
        self.showSender = showSender
    }

    public static let standard = MomoPushPresentationSettings(previewEnabled: true, showSender: true)

    private enum CodingKeys: String, CodingKey {
        case previewEnabled = "preview"
        case showSender
    }

    /// Missing container, missing file or an unreadable one all read as `standard`: the files are
    /// written atomically by the app, so a half-written file is not a state this code can be in.
    public static func load(from container: MomoPushPresentationContainer?) -> MomoPushPresentationSettings {
        guard let container,
              let data = try? Data(contentsOf: container.settingsURL),
              data.count <= 4096,
              let settings = try? JSONDecoder().decode(MomoPushPresentationSettings.self, from: data)
        else { return .standard }
        return settings
    }

    public func write(to container: MomoPushPresentationContainer) throws {
        let data = try JSONEncoder().encode(self)
        try data.write(to: container.settingsURL, options: .atomic)
    }
}

// MARK: - keys

enum MomoPushPresentationKey {
    /// `https://Host:443/` and `https://host:443` are one server.
    static func server(_ raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }

    /// Hex of the first 12 bytes of a SHA-256: a file name that never holds a URL or an id.
    static func digest(_ parts: [String]) -> String {
        let joined = parts.joined(separator: "\n")
        let hash = SHA256.hash(data: Data(joined.utf8))
        return hash.prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    static func scope(server: String, workspace: String) -> String {
        digest([Self.server(server), workspace.lowercased()])
    }

    static func member(server: String, workspace: String, member: String) -> String {
        digest([Self.server(server), workspace.lowercased(), member.lowercased()])
    }

    /// The media version (`?v=` of the avatar URL). Only the characters a media id has; anything else
    /// is not a version and the avatar is not cached (a path-shaped value must never reach a file name).
    static func version(_ raw: String) -> String? {
        guard !raw.isEmpty, raw.count <= 64,
              raw.unicodeScalars.allSatisfy({
                  ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x41 && $0.value <= 0x5A)
                      || ($0.value >= 0x61 && $0.value <= 0x7A) || $0 == "-" || $0 == "_"
              })
        else { return nil }
        return raw.lowercased()
    }
}

// MARK: - names

/// What the app knows about a channel and a push does not say: whether it is a conversation with one
/// person (no name) or a named room (`#디자인`). Ids are lower-case UUIDs, as the envelope's are.
public struct MomoPushPresentationChannel: Equatable, Sendable {
    public enum Kind: String, Sendable, Codable {
        case `public`, `private`, dm
    }

    public let id: String
    public let kind: Kind
    /// Absent for a DM. Trimmed, control characters removed, at most `nameMaxCharacters`.
    public let name: String?
    /// Active members including the sender and the person reading the notification. Optional.
    public let memberCount: Int?

    public init(id: String, kind: Kind, name: String?, memberCount: Int?) {
        self.id = id.lowercased()
        self.kind = kind
        self.name = MomoPushPresentationChannel.clean(name)
        self.memberCount = memberCount.flatMap { $0 > 0 ? $0 : nil }
    }

    static func clean(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let printable = raw.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        let text = String(String.UnicodeScalarView(printable)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return String(text.prefix(MomoPushPresentationContract.nameMaxCharacters))
    }
}

// MARK: - the cache

public struct MomoPushPresentationCache: Sendable, Equatable {
    public let rootURL: URL

    public init(rootURL: URL) {
        self.rootURL = rootURL
    }

    private var avatarsURL: URL {
        rootURL.appendingPathComponent(MomoPushPresentationContract.avatarsDirectoryName, isDirectory: true)
    }

    private var channelsURL: URL {
        rootURL.appendingPathComponent(MomoPushPresentationContract.channelsDirectoryName, isDirectory: true)
    }

    /// 로그아웃·「보낸 사람 표시」 끄기: every face and channel name this phone cached is gone.
    public func clearAll() {
        try? FileManager.default.removeItem(at: rootURL)
    }

    // ---- avatars --------------------------------------------------------------------------------

    private func avatarFileName(member: String, version: String) -> String {
        "\(member).\(version).png"
    }

    /// The cached face for EXACTLY this version of this member's photo. A different version on disk
    /// (the person changed their picture) is not an answer: showing an old face is worse than an initial.
    public func avatarPNG(
        server: String, workspace: String, member: String, version: String, now: Date = Date()
    ) -> Data? {
        guard let versionKey = MomoPushPresentationKey.version(version) else { return nil }
        let memberKey = MomoPushPresentationKey.member(server: server, workspace: workspace, member: member)
        let url = avatarsURL.appendingPathComponent(avatarFileName(member: memberKey, version: versionKey))
        let fileManager = FileManager.default
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              let modified = attributes[.modificationDate] as? Date
        else { return nil }
        guard now.timeIntervalSince(modified) <= MomoPushPresentationContract.avatarTimeToLive else {
            try? fileManager.removeItem(at: url)
            return nil
        }
        guard let size = attributes[.size] as? Int, size > 0, size <= MomoPushPresentationContract.avatarMaxBytes,
              let data = try? Data(contentsOf: url), Self.isPNG(data)
        else {
            try? fileManager.removeItem(at: url)
            return nil
        }
        // A face somebody still receives notifications from does not age out.
        try? fileManager.setAttributes([.modificationDate: now], ofItemAtPath: url.path)
        return data
    }

    /// Stores one face (already cut down: see `MomoPushPresentationImage.avatarPNG`). Refuses anything that
    /// is not a PNG or is over the byte ceiling. Replaces this member's older versions and keeps the
    /// whole cache inside its entry and byte caps by dropping the least recently used files.
    @discardableResult
    public func storeAvatarPNG(
        _ png: Data, server: String, workspace: String, member: String, version: String, now: Date = Date()
    ) -> Bool {
        guard let versionKey = MomoPushPresentationKey.version(version),
              !png.isEmpty, png.count <= MomoPushPresentationContract.avatarMaxBytes, Self.isPNG(png)
        else { return false }
        let memberKey = MomoPushPresentationKey.member(server: server, workspace: workspace, member: member)
        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(at: avatarsURL, withIntermediateDirectories: true)
            let name = avatarFileName(member: memberKey, version: versionKey)
            // The same person's other versions go first: only the current photo is worth a byte.
            for file in (try? fileManager.contentsOfDirectory(atPath: avatarsURL.path)) ?? []
            where file.hasPrefix("\(memberKey).") && file != name {
                try? fileManager.removeItem(at: avatarsURL.appendingPathComponent(file))
            }
            let url = avatarsURL.appendingPathComponent(name)
            try png.write(to: url, options: .atomic)
            try? fileManager.setAttributes([.modificationDate: now], ofItemAtPath: url.path)
        } catch {
            return false
        }
        evictAvatars(keeping: avatarFileName(member: memberKey, version: versionKey))
        return true
    }

    /// Oldest first, never the file just written.
    private func evictAvatars(keeping keep: String) {
        let fileManager = FileManager.default
        var entries: [(url: URL, modified: Date, size: Int)] = []
        for file in (try? fileManager.contentsOfDirectory(atPath: avatarsURL.path)) ?? [] {
            let url = avatarsURL.appendingPathComponent(file)
            guard let attributes = try? fileManager.attributesOfItem(atPath: url.path) else { continue }
            entries.append((
                url, (attributes[.modificationDate] as? Date) ?? .distantPast, (attributes[.size] as? Int) ?? 0))
        }
        entries.sort { $0.modified < $1.modified }
        var total = entries.reduce(0) { $0 + $1.size }
        var count = entries.count
        for entry in entries where entry.url.lastPathComponent != keep {
            if count <= MomoPushPresentationContract.avatarMaxEntries
                && total <= MomoPushPresentationContract.avatarMaxTotalBytes { break }
            try? fileManager.removeItem(at: entry.url)
            total -= entry.size
            count -= 1
        }
    }

    static func isPNG(_ data: Data) -> Bool {
        data.count > 8 && data.prefix(8) == Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    }

    // ---- channels -------------------------------------------------------------------------------

    private struct ChannelFile: Codable {
        struct Entry: Codable {
            let i: String
            let k: MomoPushPresentationChannel.Kind
            let n: String?
            let c: Int?
        }

        let v: Int
        let at: Int64
        let channels: [Entry]
    }

    private func channelFileURL(server: String, workspace: String) -> URL {
        channelsURL.appendingPathComponent("\(MomoPushPresentationKey.scope(server: server, workspace: workspace)).json")
    }

    /// Replaces the whole set for one workspace of one server (the app sends its whole channel list).
    @discardableResult
    public func replaceChannels(
        server: String, workspace: String, channels: [MomoPushPresentationChannel], now: Date = Date()
    ) -> Bool {
        let entries = channels.prefix(MomoPushPresentationContract.channelMaxEntries).map {
            ChannelFile.Entry(i: $0.id, k: $0.kind, n: $0.name, c: $0.memberCount)
        }
        let file = ChannelFile(v: 1, at: Int64(now.timeIntervalSince1970 * 1000), channels: Array(entries))
        guard let data = try? JSONEncoder().encode(file), data.count <= MomoPushPresentationContract.channelFileMaxBytes
        else { return false }
        do {
            try FileManager.default.createDirectory(at: channelsURL, withIntermediateDirectories: true)
            try data.write(to: channelFileURL(server: server, workspace: workspace), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    public func channel(
        server: String, workspace: String, channelID: String, now: Date = Date()
    ) -> MomoPushPresentationChannel? {
        let url = channelFileURL(server: server, workspace: workspace)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? Int, size > 0, size <= MomoPushPresentationContract.channelFileMaxBytes,
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(ChannelFile.self, from: data), file.v == 1
        else { return nil }
        let writtenAt = Date(timeIntervalSince1970: TimeInterval(file.at) / 1000)
        guard now.timeIntervalSince(writtenAt) <= MomoPushPresentationContract.channelTimeToLive else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        let wanted = channelID.lowercased()
        guard let entry = file.channels.first(where: { $0.i.lowercased() == wanted }) else { return nil }
        return MomoPushPresentationChannel(id: entry.i, kind: entry.k, name: entry.n, memberCount: entry.c)
    }
}

// MARK: - pictures

public enum MomoPushPresentationImage {
    /// The longest edge of the picture inside `data`, or nil when it is not an image ImageIO can read.
    static func longestEdge(of data: Data) -> Int? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        return max(width, height)
    }

    /// A centred square cut of the picture as PNG, as small as the byte ceiling needs: it tries 288 px
    /// and steps down until the file fits in 64 KB. nil when the bytes are not a picture, are too big a
    /// source for this process (`maxSourceBytes`, `maxSourceEdge`) or do not fit even at 96 px.
    public static func avatarPNG(
        from data: Data,
        maxSourceBytes: Int,
        maxSourceEdge: Int,
        maxBytes: Int = MomoPushPresentationContract.avatarMaxBytes
    ) -> Data? {
        guard !data.isEmpty, data.count <= maxSourceBytes,
              let edge = longestEdge(of: data), edge > 0, edge <= maxSourceEdge,
              let source = CGImageSourceCreateWithData(data as CFData, nil)
        else { return nil }
        for pixels in [MomoPushPresentationContract.avatarMaxPixels, 224, 192, 160, 128, 96] {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: pixels,
            ]
            guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
            else { return nil }
            let side = min(thumbnail.width, thumbnail.height)
            let square = CGRect(
                x: (thumbnail.width - side) / 2, y: (thumbnail.height - side) / 2, width: side, height: side)
            guard let cut = thumbnail.cropping(to: square), let png = encodePNG(cut) else { return nil }
            if png.count <= maxBytes { return png }
        }
        return nil
    }

    static func encodePNG(_ image: CGImage) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}

// MARK: - the face an app draws when there is no photo

/// 사진이 없을 때의 얼굴. The phone's own avatar rule (`@momo/core` `avatarIdentity`): ONE initial,
/// a person on a quiet tile, an agent on the agent tile in the agent's colour. The extension cannot
/// run the app's React tree, so the rule lives here a second time; `sim-check` holds its vectors.
public enum MomoPushPresentationAvatar {
    public enum Kind: Sendable {
        case human
        case agent
    }

    /// First code point of the name, upper-cased, only when it is a letter (`avatarInitial` in the core):
    /// a name that starts with a digit or a symbol is usually an id, and an id is not an initial.
    public static func initial(of name: String?) -> String? {
        guard let first = name?.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.first,
              CharacterSet.letters.contains(first)
        else { return nil }
        return String(first).uppercased()
    }

    /// Tile and letter colours: the default theme's light table (`packages/momo-core/src/design/themes.ts`,
    /// dawnsky light). A notification's picture is not recoloured by the system, so one set has to read
    /// on both a light and a dark lock screen.
    struct Palette: Equatable {
        let tile: (UInt8, UInt8, UInt8)
        let ring: (UInt8, UInt8, UInt8)
        let letter: (UInt8, UInt8, UInt8)

        static func == (lhs: Palette, rhs: Palette) -> Bool {
            lhs.tile == rhs.tile && lhs.ring == rhs.ring && lhs.letter == rhs.letter
        }
    }

    /// human: `surface-muted` tile, `line` ring, `ink` letter.
    static let humanPalette = Palette(tile: (0xF3, 0xF1, 0xEE), ring: (0xE7, 0xE4, 0xDF), letter: (0x16, 0x17, 0x1B))
    /// agent: `agent-soft` tile, `agent` letter.
    static let agentPalette = Palette(tile: (0xE3, 0xEC, 0xF6), ring: (0xC9, 0xD8, 0xEA), letter: (0x2F, 0x5B, 0x8A))

    /// nil when there is no letter to draw: the system then draws its own monogram, which says
    /// "someone" without the extension pretending to know an initial it does not have.
    public static func png(initial: String?, kind: Kind, pixels: Int = MomoPushPresentationContract.avatarMaxPixels)
        -> Data?
    {
        guard let initial, !initial.isEmpty, pixels >= 32 else { return nil }
        let palette = kind == .agent ? agentPalette : humanPalette
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        func color(_ rgb: (UInt8, UInt8, UInt8)) -> CGColor {
            CGColor(
                colorSpace: colorSpace,
                components: [CGFloat(rgb.0) / 255, CGFloat(rgb.1) / 255, CGFloat(rgb.2) / 255, 1])!
        }
        let full = CGRect(x: 0, y: 0, width: pixels, height: pixels)
        context.setFillColor(color(palette.tile))
        context.fill(full)
        // The system cuts the picture to a circle; the ring marks the edge on a light banner.
        context.setStrokeColor(color(palette.ring))
        context.setLineWidth(CGFloat(pixels) * 0.02)
        context.strokeEllipse(in: full.insetBy(dx: CGFloat(pixels) * 0.01, dy: CGFloat(pixels) * 0.01))

        let fontSize = CGFloat(pixels) * 0.46
        let font = CTFontCreateUIFontForLanguage(.system, fontSize, nil)
            ?? CTFontCreateWithName("HelveticaNeue-Medium" as CFString, fontSize, nil)
        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color(palette.letter),
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: initial, attributes: attributes))
        let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
        context.textPosition = CGPoint(
            x: (CGFloat(pixels) - bounds.width) / 2 - bounds.minX,
            y: (CGFloat(pixels) - bounds.height) / 2 - bounds.minY)
        CTLineDraw(line, context)
        guard let image = context.makeImage() else { return nil }
        return MomoPushPresentationImage.encodePNG(image)
    }
}

// MARK: - forgetting

/// 로그아웃·계정 전환·「보낸 사람 표시」 끄기: the cache goes and the system is asked to forget the
/// communication interactions this app donated (`INInteraction.deleteAll`, injected: the file that
/// owns Intents decides what it is).
///
/// A deletion that did not finish (the process was suspended, the system was busy) must not be
/// forgotten with the process, so a marker is written BEFORE the call and removed only after the
/// system said yes; `retryPending` runs at the next app start. This is the retry rule of Buzz's
/// `BuzzInteractionCleanupRetry` (Apache-2.0, NOTICE), without its cross-process lock: one marker,
/// one acknowledgement that removes it only if no newer request replaced it.
public final class MomoPushPresentationCleanup: @unchecked Sendable {
    public typealias DeleteAllInteractions = (@escaping (Error?) -> Void) -> Void
    public typealias ScheduleTimeout = (TimeInterval, @escaping () -> Void) -> Void

    private let container: MomoPushPresentationContainer?
    private let deleteAllInteractions: DeleteAllInteractions
    private let scheduleTimeout: ScheduleTimeout
    private let timeout: TimeInterval

    public init(
        container: MomoPushPresentationContainer?,
        deleteAllInteractions: @escaping DeleteAllInteractions,
        timeout: TimeInterval = 5,
        scheduleTimeout: @escaping ScheduleTimeout = { delay, action in
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay, execute: action)
        }
    ) {
        self.container = container
        self.deleteAllInteractions = deleteAllInteractions
        self.timeout = timeout
        self.scheduleTimeout = scheduleTimeout
    }

    /// Writes the marker, clears the cache (unless the caller only needs the donations gone), asks the
    /// system, and removes the marker once the system answered without an error. `completion` is
    /// called exactly once: with the system's error, or with a timeout error when it did not answer.
    public func request(clearCache: Bool = true, completion: @escaping (Error?) -> Void) {
        let token = UUID().uuidString
        if let container {
            try? Data(token.utf8).write(to: container.cleanupMarkerURL, options: .atomic)
            if clearCache { container.cache.clearAll() }
        }
        delete(token: token, completion: completion)
    }

    /// At app start: finish what an earlier run started and did not finish. No marker, no call.
    public func retryPending(completion: @escaping (Error?) -> Void) {
        guard let container,
              let data = try? Data(contentsOf: container.cleanupMarkerURL),
              let token = String(data: data, encoding: .utf8), !token.isEmpty
        else {
            completion(nil)
            return
        }
        delete(token: token, completion: completion)
    }

    public func hasPendingCleanup() -> Bool {
        guard let container else { return false }
        return FileManager.default.fileExists(atPath: container.cleanupMarkerURL.path)
    }

    private func delete(token: String, completion: @escaping (Error?) -> Void) {
        let once = OneShot(completion)
        scheduleTimeout(timeout) {
            once.complete(
                NSError(
                    domain: "MomoPushPresentationCleanup", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Timed out deleting communication interactions."]))
        }
        deleteAllInteractions { [weak self] error in
            if error == nil { self?.acknowledge(token: token) }
            once.complete(error)
        }
    }

    /// A newer request replaced the marker while this one was in flight: leave it, it is still owed.
    private func acknowledge(token: String) {
        guard let container,
              let data = try? Data(contentsOf: container.cleanupMarkerURL),
              String(data: data, encoding: .utf8) == token
        else { return }
        try? FileManager.default.removeItem(at: container.cleanupMarkerURL)
    }

    private final class OneShot: @unchecked Sendable {
        private let lock = NSLock()
        private var completion: ((Error?) -> Void)?

        init(_ completion: @escaping (Error?) -> Void) {
            self.completion = completion
        }

        func complete(_ error: Error?) {
            lock.lock()
            let completion = self.completion
            self.completion = nil
            lock.unlock()
            completion?(error)
        }
    }
}
