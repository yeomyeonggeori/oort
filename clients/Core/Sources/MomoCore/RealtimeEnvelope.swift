import Foundation

/// The single wire envelope every Centrifugo publication uses (L4 §5.2):
/// `{ "type": "...", "v": 1, "ts": <ms>, "seq": <bigint?>, "payload": {...} }`.
///
/// Decoders downstream of SwiftCentrifuge decode this, then call `decodeEvent()`
/// to map it to a strongly-typed `RealtimeEvent`.
public struct RealtimeEnvelope: Codable, Sendable, Hashable {
    /// e.g. "message.new", "agent.partial", "approval.requested".
    public var type: String
    /// Envelope version (currently 1).
    public var v: Int
    /// Publish timestamp, ms since epoch UTC.
    public var ts: Int64
    /// Authoritative per-channel seq when applicable (= Centrifugo publish version).
    public var seq: Int64?
    /// Type-specific body.
    public var payload: JSON

    public init(type: String, v: Int = 1, ts: Int64, seq: Int64? = nil, payload: JSON) {
        self.type = type
        self.v = v
        self.ts = ts
        self.seq = seq
        self.payload = payload
    }

    /// Known envelope `type` strings (L4 §5.2 taxonomy).
    public enum EventType: String {
        case messageNew = "message.new"
        case messageEdited = "message.edited"
        case messageDeleted = "message.deleted"
        case threadUpdated = "thread.updated"
        case reactionAdded = "reaction.added"
        case reactionRemoved = "reaction.removed"
        case typingStart = "typing.start"
        case typingStop = "typing.stop"
        case agentStatus = "agent.status"
        case agentPartial = "agent.partial"
        case approvalRequested = "approval.requested"
        case approvalDecided = "approval.decided"
        case mention = "mention"
        case dmSignal = "dm.signal"
        case huddleStarted = "huddle_started"
        case huddleParticipantsChanged = "huddle_participants_changed"
        case huddleEnded = "huddle_ended"
        case workSessionStarted = "work.session.started"
        case workSessionEnded = "work.session.ended"
    }

    /// Errors raised while mapping an envelope to a `RealtimeEvent`.
    public enum DecodeError: Error, Sendable {
        /// `type` is not one this client recognizes (forward-compat: caller may ignore).
        case unknownType(String)
        /// `payload` shape did not match the expected type for `type`.
        case malformedPayload(String, underlying: Error)
        /// Required scalar (e.g. message id for a delete) was missing/invalid.
        case missingField(String)
    }

    /// Map this envelope to a strongly-typed `RealtimeEvent`.
    /// Throws `DecodeError.unknownType` for unrecognized types so callers can
    /// choose to skip rather than crash (forward compatibility).
    public func decodeEvent(decoder: JSONDecoder = .momo) throws -> RealtimeEvent {
        guard let kind = EventType(rawValue: type) else {
            throw DecodeError.unknownType(type)
        }

        func decode<T: Decodable>(_ t: T.Type) throws -> T {
            do {
                let data = try JSONEncoder.momo.encode(payload)
                return try decoder.decode(T.self, from: data)
            } catch {
                throw DecodeError.malformedPayload(type, underlying: error)
            }
        }

        switch kind {
        case .messageNew:
            return .message(try decode(Message.self))
        case .messageEdited:
            return .messageEdited(try decode(Message.self))
        case .messageDeleted:
            // payload: { "message_id": "<uuid>" }
            guard let idStr = payload["message_id"]?.stringValue,
                  let id = MessageID(idStr) else {
                throw DecodeError.missingField("message_id")
            }
            return .messageDeleted(id)
        case .threadUpdated:
            return .threadUpdated(try decode(ThreadRollupDelta.self))
        case .reactionAdded, .reactionRemoved:
            return .reaction(try decode(ReactionDelta.self))
        case .typingStart, .typingStop:
            return .typing(try decode(TypingDelta.self))
        case .agentStatus:
            return .agentStatus(try decode(AgentStatus.self))
        case .agentPartial:
            return .agentPartial(try decode(AgentPartial.self))
        case .approvalRequested, .approvalDecided:
            return .approval(try decode(ApprovalEvent.self))
        case .mention, .dmSignal:
            // `user:` namespace notifications are not part of RealtimeEvent (L4 §5.3);
            // surface as unknown so channel subscribers ignore them.
            throw DecodeError.unknownType(type)
        case .huddleStarted, .huddleParticipantsChanged, .huddleEnded:
            let action: String = switch kind {
            case .huddleStarted: "started"
            case .huddleParticipantsChanged: "participants_changed"
            case .huddleEnded: "ended"
            default: preconditionFailure("non-huddle event reached huddle decoder")
            }
            var object = payload.objectValue ?? [:]
            object["action"] = .string(action)
            do {
                let data = try JSONEncoder.momo.encode(JSON.object(object))
                return .huddle(try decoder.decode(HuddleDelta.self, from: data))
            } catch {
                throw DecodeError.malformedPayload(type, underlying: error)
            }
        case .workSessionStarted, .workSessionEnded:
            let action: String = kind == .workSessionStarted ? "started" : "ended"
            var object = payload.objectValue ?? [:]
            object["action"] = .string(action)
            do {
                let data = try JSONEncoder.momo.encode(JSON.object(object))
                return .workSession(try decoder.decode(WorkSessionDelta.self, from: data))
            } catch {
                throw DecodeError.malformedPayload(type, underlying: error)
            }
        }
    }
}
