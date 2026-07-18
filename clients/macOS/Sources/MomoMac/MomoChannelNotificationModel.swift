import Foundation
import MomoCore

/// Optional macOS capability for per-member channel notification preferences.
/// The server remains authoritative; the UI only projects the current member's
/// mute state returned by the channel list and preference endpoint.
protocol MomoChannelNotificationBackend: Sendable {
    func channelMuteSnapshot(workspace: WorkspaceID) async -> [ChannelID: Bool]
    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool
}

public enum MomoChannelNotificationError: Equatable {
    case updateFailed

    func message(copy: MomoWorkspaceCopy) -> String {
        switch copy.language {
        case .korean:
            return "채널 알림 설정을 변경하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요."
        case .english:
            return "The channel notification setting could not be changed. Check your connection and try again."
        }
    }
}
