import Foundation

public actor ACPJSONLinesFileSink: ACPEventSink {
    private let handle: FileHandle
    private let encoder = JSONEncoder()

    public init(url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        if !FileManager.default.fileExists(atPath: url.path) {
            guard FileManager.default.createFile(
                atPath: url.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            ) else { throw ACPHostError.transportClosed }
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
    }

    deinit { try? handle.close() }

    public func emit(_ event: ACPProjectedEvent) async {
        guard var data = try? encoder.encode(event) else { return }
        data.append(0x0A)
        try? handle.write(contentsOf: data)
    }
}
