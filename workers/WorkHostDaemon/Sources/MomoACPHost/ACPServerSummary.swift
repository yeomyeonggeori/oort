import Foundation

extension ACPProjectedEvent {
    /// ADR-0004 allowlist. Raw ACP `_meta`, terminal bytes, commands,
    /// environment, paths, and credentials cannot cross this projection.
    func serverSummary() -> ACPProjectedEvent? {
        guard let source = payload.objectValue else { return nil }
        var safe: [String: ACPValue] = [:]
        for key in ["run_id", "work_session_id", "channel_id", "agent_member_id"] {
            if let value = source[key]?.stringValue {
                safe[key] = .string(boundedString(value, maximumBytes: 128))
            }
        }
        switch type {
        case "agent.partial":
            guard let text = source["text_delta"]?.stringValue else { return nil }
            safe["text_delta"] = .string(boundedString(text, maximumBytes: 4_096))
        case "agent.status":
            for key in ["phase", "run_status", "terminal_event"] {
                if let value = source[key]?.stringValue {
                    safe[key] = .string(boundedString(value, maximumBytes: 64))
                }
            }
            for key in ["detail", "tool_call_name"] {
                if let value = source[key]?.stringValue {
                    safe[key] = .string(boundedString(value, maximumBytes: 4_096))
                }
            }
            if let value = source["has_plan"] { safe["has_plan"] = value }
            if let value = source["plan"] { safe["plan"] = bounded(value, depth: 0) }
            if let value = source["exit_code"]?.intValue { safe["exit_code"] = .int(value) }
        case "approval.requested":
            safe["action"] = .string("requested")
            safe["action_type"] = .string("tool_call")
            safe["status"] = .string("pending")
            if let options = source["options"]?.arrayValue {
                safe["options"] = .array(options.prefix(16).compactMap { option in
                    guard let object = option.objectValue,
                          let optionID = object["option_id"]?.stringValue,
                          let name = object["name"]?.stringValue
                    else { return nil }
                    var item: [String: ACPValue] = [
                        "option_id": .string(boundedString(optionID, maximumBytes: 128)),
                        "name": .string(boundedString(name, maximumBytes: 256)),
                    ]
                    if let kind = object["kind"]?.stringValue {
                        item["kind"] = .string(boundedString(kind, maximumBytes: 64))
                    }
                    return .object(item)
                })
            }
        case "approval.decided":
            safe["action"] = .string("decided")
            guard let status = source["status"]?.stringValue,
                  status == "approved" || status == "rejected"
            else { return nil }
            safe["status"] = .string(status)
            if let optionID = source["option_id"]?.stringValue {
                safe["option_id"] = .string(boundedString(optionID, maximumBytes: 128))
            }
        default:
            return nil
        }
        return ACPProjectedEvent(id: id, type: type, timestampMs: timestampMs, payload: .object(safe))
    }

    private func bounded(_ value: ACPValue, depth: Int) -> ACPValue {
        guard depth < 6 else { return .null }
        switch value {
        case .object(let object):
            return .object(Dictionary(uniqueKeysWithValues: object.lazy
                .filter { !isForbiddenKey($0.key) }
                .prefix(64)
                .map {
                    (boundedString($0.key, maximumBytes: 128), bounded($0.value, depth: depth + 1))
                }))
        case .array(let array):
            return .array(array.prefix(64).map { bounded($0, depth: depth + 1) })
        case .string(let string): return .string(boundedString(string, maximumBytes: 4_096))
        case .int, .double, .bool, .null: return value
        }
    }

    private func isForbiddenKey(_ key: String) -> Bool {
        let lowered = key.lowercased()
        return ["_meta", "credential", "token", "secret", "environment",
                "env", "command", "output", "cwd", "path", "raw"]
            .contains(where: lowered.contains)
    }

    private func boundedString(_ value: String, maximumBytes: Int) -> String {
        var result = ""
        var byteCount = 0
        for character in value {
            let characterBytes = String(character).utf8.count
            guard byteCount + characterBytes <= maximumBytes else { break }
            result.append(character)
            byteCount += characterBytes
        }
        return result
    }
}
