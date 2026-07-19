import Foundation

// MARK: - Strongly-typed identifiers
//
// All server PKs are UUIDv7 (schema_v0.sql). We wrap UUID in phantom-typed structs
// so a ChannelID can never be passed where a MessageID is expected. They are
// Codable as bare UUIDs on the wire and LosslessStringConvertible for URLs/paths.

/// A type-safe UUID identifier tag. Use the `typealias`es below, never `ID<...>` directly.
public struct Identifier<Tag>: Hashable, Sendable, Codable, CustomStringConvertible, LosslessStringConvertible {
    public let rawValue: UUID

    public init(_ rawValue: UUID) { self.rawValue = rawValue }

    /// Mint a fresh identifier (e.g. a client_msg_id for optimistic sends).
    public init() { self.rawValue = UUID() }

    public init?(_ description: String) {
        guard let uuid = UUID(uuidString: description) else { return nil }
        self.rawValue = uuid
    }

    public init?(uuidString: String) {
        guard let uuid = UUID(uuidString: uuidString) else { return nil }
        self.rawValue = uuid
    }

    public var description: String { rawValue.uuidString }

    // Encode/decode as a bare UUID string to match server JSON.
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.rawValue = try container.decode(UUID.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

// Phantom tag types (never instantiated).
public enum WorkspaceTag {}
public enum MemberTag {}
public enum ChannelTag {}
public enum MessageTag {}
public enum RunTag {}
public enum ApprovalTag {}
public enum ReactionTag {}
public enum FileTag {}
public enum DeviceTag {}
public enum WorkSessionTag {}
public enum WorkHostTag {}
public enum WorkControlTag {}

public typealias WorkspaceID = Identifier<WorkspaceTag>
public typealias MemberID = Identifier<MemberTag>
public typealias ChannelID = Identifier<ChannelTag>
public typealias MessageID = Identifier<MessageTag>
public typealias RunID = Identifier<RunTag>
public typealias ApprovalID = Identifier<ApprovalTag>
public typealias ReactionID = Identifier<ReactionTag>
public typealias FileID = Identifier<FileTag>
public typealias DeviceID = Identifier<DeviceTag>
public typealias WorkSessionID = Identifier<WorkSessionTag>
public typealias WorkHostID = Identifier<WorkHostTag>
public typealias WorkControlID = Identifier<WorkControlTag>
