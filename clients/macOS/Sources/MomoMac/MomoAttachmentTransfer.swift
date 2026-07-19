import Foundation
import MomoCore

/// Narrow attachment capability exposed by real chat backends.
///
/// The opaque upload URL is intentionally absent from this contract: the REST
/// backend consumes it inside one call so UI state, logs, and persistence can
/// only ever observe download-safe attachment metadata.
protocol MomoAttachmentTransferBackend: Sendable {
    func uploadAttachment(fileURL: URL, to channel: ChannelID) async throws -> MessageAttachment
    func downloadAttachment(
        _ attachment: MessageAttachment,
        from channel: ChannelID,
        to destinationURL: URL
    ) async throws
}

enum MomoAttachmentTransferIssue: Error, Equatable {
    case invalidFile
    case fileTooLarge
    case unavailable
}

enum MomoAttachmentDownloadState: Equatable {
    case downloading
    case completed(URL)
    case failed
}

enum MomoAttachmentFileBoundary {
    static let maximumSizeBytes: Int64 = 100 * 1_024 * 1_024

    static func destinationURL(
        named originalName: String,
        in downloadsFolder: URL,
        fileManager: FileManager = .default
    ) throws -> URL {
        let safeName = sanitizedFileName(originalName)
        let base = (safeName as NSString).deletingPathExtension
        let ext = (safeName as NSString).pathExtension

        for suffix in 0..<10_000 {
            let candidateName: String
            if suffix == 0 {
                candidateName = safeName
            } else if ext.isEmpty {
                candidateName = "\(base) (\(suffix + 1))"
            } else {
                candidateName = "\(base) (\(suffix + 1)).\(ext)"
            }
            let candidate = downloadsFolder
                .appendingPathComponent(candidateName, isDirectory: false)
                .standardizedFileURL
            guard candidate.deletingLastPathComponent().standardizedFileURL == downloadsFolder.standardizedFileURL else {
                throw MomoAttachmentTransferIssue.invalidFile
            }
            if !fileManager.fileExists(atPath: candidate.path) {
                return candidate
            }
        }
        throw MomoAttachmentTransferIssue.unavailable
    }

    static func sanitizedFileName(_ originalName: String) -> String {
        let leaf = URL(fileURLWithPath: originalName).lastPathComponent
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let cleaned = leaf.unicodeScalars.map { scalar -> Character in
            switch scalar.value {
            case 0, 47, 58:
                return "-"
            default:
                return Character(String(scalar))
            }
        }
        let value = String(cleaned)
        return value.isEmpty || value == "." || value == ".." ? "attachment" : value
    }
}
