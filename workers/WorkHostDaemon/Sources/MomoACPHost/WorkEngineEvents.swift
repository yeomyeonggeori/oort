import Foundation

// =============================================================================
// WorkEngineEvents — projects opencode/Codex engine activity into momo's shared
// ACPProjectedEvent envelope (MOMO-579 / WH-1).
//
// The ACP/goose path already projects via ACPEventProjection; this mirror keeps
// opencode + Codex on the exact same event types (agent.partial / agent.status /
// approval.requested / approval.decided) so the work console and the relay
// summary path are engine-agnostic. Engine-native detail is retained only under
// `payload._meta.<engine>` (host-local), never in the relayed summary.
// =============================================================================
enum WorkEngineEvents {
    static func messageDelta(
        _ text: String,
        engine: WorkEngine,
        context: ACPHostContext,
        nowMs: Int64,
        raw: ACPValue = .object([:])
    ) -> ACPProjectedEvent {
        var payload = basePayload(context: context)
        payload["text_delta"] = .string(text)
        payload["_meta"] = .object([engine.rawValue: raw])
        return ACPProjectedEvent(type: "agent.partial", timestampMs: nowMs, payload: .object(payload))
    }

    static func status(
        detail: String,
        phase: String = "streaming",
        engine: WorkEngine,
        context: ACPHostContext,
        nowMs: Int64,
        raw: ACPValue = .object([:])
    ) -> ACPProjectedEvent {
        var payload = basePayload(context: context)
        payload["phase"] = .string(phase)
        payload["run_status"] = .string("running")
        payload["detail"] = .string(detail)
        payload["has_plan"] = .bool(false)
        payload["_meta"] = .object([engine.rawValue: raw])
        return ACPProjectedEvent(type: "agent.status", timestampMs: nowMs, payload: .object(payload))
    }

    static func approvalRequested(
        _ request: WorkApprovalRequest,
        context: ACPHostContext,
        nowMs: Int64
    ) -> ACPProjectedEvent {
        var payload = basePayload(context: context)
        payload["action"] = .string("requested")
        payload["action_type"] = .string("tool_call")
        payload["status"] = .string("pending")
        payload["engine"] = .string(request.engine.rawValue)
        if let toolName = request.toolName { payload["tool_call_name"] = .string(toolName) }
        if let title = request.title { payload["title"] = .string(title) }
        payload["options"] = .array(request.options.map {
            .object([
                "option_id": .string($0.optionID),
                "name": .string($0.name),
                "kind": .string($0.kind.rawValue),
            ])
        })
        // The engine-native request payload stays host-local under _meta.
        payload["_meta"] = .object([request.engine.rawValue: request.raw])
        return ACPProjectedEvent(type: "approval.requested", timestampMs: nowMs, payload: .object(payload))
    }

    static func approvalDecided(
        _ decision: WorkApprovalDecision,
        engine: WorkEngine,
        context: ACPHostContext,
        nowMs: Int64
    ) -> ACPProjectedEvent {
        var payload = basePayload(context: context)
        payload["action"] = .string("decided")
        payload["engine"] = .string(engine.rawValue)
        switch decision {
        case .allow(let optionID):
            payload["status"] = .string("approved")
            payload["option_id"] = .string(optionID)
        case .deny(let optionID):
            payload["status"] = .string("rejected")
            if let optionID { payload["option_id"] = .string(optionID) }
        case .cancelled:
            payload["status"] = .string("rejected")
        }
        return ACPProjectedEvent(type: "approval.decided", timestampMs: nowMs, payload: .object(payload))
    }

    static func basePayload(context: ACPHostContext) -> [String: ACPValue] {
        var payload: [String: ACPValue] = [
            "run_id": .string(context.workSessionID.uuidString.lowercased()),
            "work_session_id": .string(context.workSessionID.uuidString.lowercased()),
            "channel_id": .string(context.channelID.uuidString.lowercased()),
        ]
        if let agentMemberID = context.agentMemberID {
            payload["agent_member_id"] = .string(agentMemberID.uuidString.lowercased())
        }
        return payload
    }
}
