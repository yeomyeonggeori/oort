import Foundation

/// Host-directed work control projection from ADR-0114 D4/D5. The payload is
/// deliberately limited by the server to tool/label, input text, or tail count;
/// paths, environment variables, and credentials are never part of this model.
public struct WorkControlDelta: Codable, Sendable, Hashable {
    public enum Action: String, Codable, Sendable, Hashable {
        case dispatched, acked
    }

    public enum Kind: String, Codable, Sendable, Hashable {
        case spawn, input, read, kill
    }

    public var action: Action
    public var controlId: WorkControlID
    public var channelId: ChannelID
    public var requesterMemberId: MemberID
    public var targetHostId: WorkHostID
    public var sessionId: WorkSessionID?
    public var kind: Kind
    public var payload: JSON
    public var status: String?
    public var ok: Bool?
    public var errorLabel: String?

    public init(
        action: Action,
        controlId: WorkControlID,
        channelId: ChannelID,
        requesterMemberId: MemberID,
        targetHostId: WorkHostID,
        sessionId: WorkSessionID? = nil,
        kind: Kind,
        payload: JSON,
        status: String? = nil,
        ok: Bool? = nil,
        errorLabel: String? = nil
    ) {
        self.action = action
        self.controlId = controlId
        self.channelId = channelId
        self.requesterMemberId = requesterMemberId
        self.targetHostId = targetHostId
        self.sessionId = sessionId
        self.kind = kind
        self.payload = payload
        self.status = status
        self.ok = ok
        self.errorLabel = errorLabel
    }

    private enum CodingKeys: String, CodingKey {
        case action
        case controlId = "control_id"
        case channelId = "channel_id"
        case requesterMemberId = "requester_member_id"
        case targetHostId = "target_host_id"
        case sessionId = "session_id"
        case kind, payload, status, ok
        case errorLabel = "error_label"
    }
}
