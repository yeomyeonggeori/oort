import Foundation
import MomoCore
import MomoiOSPushKit

public enum IOSPushActionIntent: Sendable, Equatable {
    case quickReply(String)
    case decideApproval(Bool)
}

public enum IOSPushActionError: Error, Equatable {
    case workspaceMismatch
    case invalidTarget
    case unsupportedAction
    case emptyReply
}

public struct IOSPushActionExecutor: Sendable {
    private let backend: any IOSConversationBackend

    public init(backend: any IOSConversationBackend) {
        self.backend = backend
    }

    public func perform(
        _ intent: IOSPushActionIntent,
        envelope: MomoPushEnvelope,
        signedInWorkspaceID: WorkspaceID
    ) async throws {
        guard envelope.workspaceID.lowercased() == signedInWorkspaceID.description.lowercased() else {
            throw IOSPushActionError.workspaceMismatch
        }
        guard let channelID = ChannelID(uuidString: envelope.channelID.lowercased()),
              let messageID = MessageID(uuidString: envelope.messageID.lowercased())
        else { throw IOSPushActionError.invalidTarget }

        switch intent {
        case .quickReply(let rawText):
            guard envelope.category == .message || envelope.category == .mention else {
                throw IOSPushActionError.unsupportedAction
            }
            let body = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !body.isEmpty else { throw IOSPushActionError.emptyReply }
            let threadRoot = envelope.threadRootID.flatMap {
                MessageID(uuidString: $0.lowercased())
            }
            var props: [String: JSON] = [:]
            if threadRoot != nil {
                props["reply_to_id"] = .string(messageID.description.lowercased())
            }
            _ = try await backend.send(
                DraftMessage(
                    channelId: channelID,
                    type: .text,
                    body: body,
                    props: .object(props),
                    rootId: threadRoot,
                    replyToId: threadRoot == nil ? nil : messageID
                ),
                clientMsgId: UUID()
            )

        case .decideApproval(let approve):
            guard envelope.category == .approval,
                  let rawApprovalID = envelope.approvalID,
                  let approvalID = ApprovalID(uuidString: rawApprovalID.lowercased())
            else { throw IOSPushActionError.unsupportedAction }
            _ = try await backend.decideApproval(ApprovalDecisionRequest(
                approvalId: approvalID,
                approve: approve,
                reason: nil,
                clientDecisionId: UUID()
            ))
        }
    }
}
