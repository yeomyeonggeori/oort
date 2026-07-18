/// Download-safe metadata for a completed attachment bound to a message.
/// Upload capability URLs and archive provider identifiers are intentionally
/// absent; clients consume `id` through the authenticated content proxy.
public struct MessageAttachment: Identifiable, Codable, Sendable, Hashable {
    public let id: FileID
    public var name: String
    public var mime: String
    public var sizeBytes: Int64

    public init(id: FileID, name: String, mime: String, sizeBytes: Int64) {
        self.id = id
        self.name = name
        self.mime = mime
        self.sizeBytes = sizeBytes
    }
}
