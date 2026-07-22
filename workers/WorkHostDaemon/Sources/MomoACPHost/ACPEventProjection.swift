import Foundation

enum ACPEventProjection {
    static func sessionUpdate(
        _ params: ACPValue,
        context: ACPHostContext,
        nowMs: Int64
    ) -> ACPProjectedEvent {
        let object = params.objectValue ?? [:]
        let update = object["update"] ?? .object([:])
        let updateObject = update.objectValue ?? [:]
        let discriminator = updateObject["sessionUpdate"]?.stringValue ?? "progress"
        let content = updateObject["content"]?.objectValue
        let text = content?["text"]?.stringValue
            ?? updateObject["message"]?.stringValue
            ?? updateObject["title"]?.stringValue
            ?? discriminator.replacingOccurrences(of: "_", with: " ")

        var payload = basePayload(context: context)
        payload["_meta"] = .object(["acp": update])
        switch discriminator {
        case "agent_message_chunk", "agent_thought_chunk":
            payload["text_delta"] = .string(text)
            return ACPProjectedEvent(type: "agent.partial", timestampMs: nowMs, payload: .object(payload))
        case "tool_call", "tool_call_update":
            payload["phase"] = .string("streaming")
            payload["run_status"] = .string("running")
            payload["detail"] = .string(text)
            payload["tool_call_name"] = updateObject["title"] ?? .string("ACP tool call")
            return ACPProjectedEvent(type: "agent.status", timestampMs: nowMs, payload: .object(payload))
        case "plan":
            payload["phase"] = .string("thinking")
            payload["run_status"] = .string("running")
            payload["detail"] = .string(text)
            payload["has_plan"] = .bool(true)
            payload["plan"] = updateObject["entries"] ?? update
            return ACPProjectedEvent(type: "agent.status", timestampMs: nowMs, payload: .object(payload))
        default:
            payload["phase"] = .string("streaming")
            payload["run_status"] = .string("running")
            payload["detail"] = .string(text)
            payload["has_plan"] = .bool(false)
            return ACPProjectedEvent(type: "agent.status", timestampMs: nowMs, payload: .object(payload))
        }
    }

    static func permission(
        _ request: ACPPermissionRequest,
        context: ACPHostContext,
        nowMs: Int64
    ) -> ACPProjectedEvent {
        var payload = basePayload(context: context)
        payload["action"] = .string("requested")
        payload["action_type"] = .string("tool_call")
        payload["status"] = .string("pending")
        payload["options"] = .array(request.options.map {
            .object([
                "option_id": .string($0.optionID),
                "name": .string($0.name),
                "kind": $0.kind.map(ACPValue.string) ?? .null,
            ])
        })
        payload["_meta"] = .object(["acp": .object(["tool_call": request.toolCall])])
        return ACPProjectedEvent(type: "approval.requested", timestampMs: nowMs, payload: .object(payload))
    }

    static func permissionDecision(
        _ decision: ACPPermissionDecision,
        context: ACPHostContext,
        nowMs: Int64
    ) -> ACPProjectedEvent {
        var payload = basePayload(context: context)
        payload["action"] = .string("decided")
        switch decision {
        case .selected(let optionID):
            payload["status"] = .string("approved")
            payload["option_id"] = .string(optionID)
        case .cancelled:
            payload["status"] = .string("rejected")
        }
        return ACPProjectedEvent(type: "approval.decided", timestampMs: nowMs, payload: .object(payload))
    }

    static func terminal(
        event: String,
        exitCode: Int? = nil,
        context: ACPHostContext,
        nowMs: Int64
    ) -> ACPProjectedEvent {
        var payload = basePayload(context: context)
        payload["phase"] = .string("streaming")
        payload["run_status"] = .string("running")
        payload["terminal_event"] = .string(event)
        payload["detail"] = .string(event == "created" ? "Terminal created" : "Terminal ended")
        if let exitCode { payload["exit_code"] = .int(exitCode) }
        return ACPProjectedEvent(type: "agent.status", timestampMs: nowMs, payload: .object(payload))
    }

    private static func basePayload(context: ACPHostContext) -> [String: ACPValue] {
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
