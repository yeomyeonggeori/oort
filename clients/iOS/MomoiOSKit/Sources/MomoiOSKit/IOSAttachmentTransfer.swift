import Foundation
import MomoCore
import UniformTypeIdentifiers

public enum IOSAttachmentTransferIssue: Error, Equatable, Sendable {
    case invalidFile
    case fileTooLarge
    case unavailable
}

public enum IOSAttachmentDraftFailure: Equatable, Sendable {
    case fileTooLarge
    case unavailable
}

public enum IOSAttachmentDraftState: Equatable, Sendable {
    case ready
    case uploading
    case uploaded(MessageAttachment)
    case failed(IOSAttachmentDraftFailure)
}

public struct IOSAttachmentDraft: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let fileURL: URL
    public let name: String
    public let mime: String
    public let sizeBytes: Int64
    public var state: IOSAttachmentDraftState

    init(
        id: UUID = UUID(),
        fileURL: URL,
        name: String,
        mime: String,
        sizeBytes: Int64,
        state: IOSAttachmentDraftState = .ready
    ) {
        self.id = id
        self.fileURL = fileURL
        self.name = name
        self.mime = mime
        self.sizeBytes = sizeBytes
        self.state = state
    }
}

public enum IOSAttachmentDownloadState: Equatable, Sendable {
    case downloading
    case completed(URL)
    case failed
}

enum IOSAttachmentFileBoundary {
    static let maximumSizeBytes: Int64 = 100 * 1_024 * 1_024

    static func draft(for fileURL: URL) throws -> IOSAttachmentDraft {
        let didAccess = fileURL.startAccessingSecurityScopedResource()
        defer {
            if didAccess { fileURL.stopAccessingSecurityScopedResource() }
        }
        let values: URLResourceValues
        do {
            values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        } catch {
            throw IOSAttachmentTransferIssue.invalidFile
        }
        guard fileURL.isFileURL,
              values.isRegularFile == true,
              let fileSize = values.fileSize,
              fileSize >= 0 else {
            throw IOSAttachmentTransferIssue.invalidFile
        }
        guard Int64(fileSize) <= maximumSizeBytes else {
            throw IOSAttachmentTransferIssue.fileTooLarge
        }
        return IOSAttachmentDraft(
            fileURL: fileURL,
            name: sanitizedFileName(fileURL.lastPathComponent),
            mime: UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType
                ?? "application/octet-stream",
            sizeBytes: Int64(fileSize)
        )
    }

    static func materialize(_ data: Data, named proposedName: String) throws -> URL {
        guard Int64(data.count) <= maximumSizeBytes else {
            throw IOSAttachmentTransferIssue.fileTooLarge
        }
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("momo-attachment-drafts", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let destination = folder.appendingPathComponent(
                "\(UUID().uuidString)-\(sanitizedFileName(proposedName))",
                isDirectory: false
            )
            try data.write(to: destination, options: [.atomic])
            return destination
        } catch let issue as IOSAttachmentTransferIssue {
            throw issue
        } catch {
            throw IOSAttachmentTransferIssue.unavailable
        }
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
