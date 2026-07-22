import Foundation
import MomoCore

/// Canonical copy for iOS workspace membership surfaces.
/// Keep user-visible membership language here instead of scattering literals through views.
struct IOSWorkspaceCopy {
    let isKorean: Bool

    static var current: Self {
        let preferred = Locale.preferredLanguages.first?.lowercased() ?? ""
        return Self(isKorean: preferred.hasPrefix("ko"))
    }

    var dismiss: String { isKorean ? "닫기" : "Dismiss" }
    var cancel: String { isKorean ? "취소" : "Cancel" }
    var members: String { isKorean ? "멤버" : "Members" }
    var auditLog: String { isKorean ? "감사 로그" : "Audit log" }
    var handle: String { isKorean ? "핸들" : "Handle" }
    var type: String { isKorean ? "유형" : "Type" }
    var status: String { isKorean ? "상태" : "Status" }
    var role: String { isKorean ? "역할" : "Role" }
    var agent: String { isKorean ? "에이전트" : "Agent" }
    var person: String { isKorean ? "사용자" : "Person" }
    var access: String { isKorean ? "접근 권한" : "Access" }
    var workspaceRole: String { isKorean ? "워크스페이스 역할" : "Workspace role" }
    var saveRole: String { isKorean ? "역할 저장" : "Save role" }
    var reinstateMember: String { isKorean ? "멤버 복구" : "Reinstate member" }
    var suspendMember: String { isKorean ? "멤버 일시 정지" : "Suspend member" }
    var removeMember: String { isKorean ? "멤버 제거" : "Remove member" }
    var reinstate: String { isKorean ? "복구" : "Reinstate" }
    var suspend: String { isKorean ? "일시 정지" : "Suspend" }
    var reinstateQuestion: String { isKorean ? "이 멤버를 복구할까요?" : "Reinstate this member?" }
    var suspendQuestion: String { isKorean ? "이 멤버를 일시 정지할까요?" : "Suspend this member?" }
    var reinstateExplanation: String {
        isKorean
            ? "멤버가 다시 로그인할 수 있습니다. 이전에 종료된 로그인 세션은 복원되지 않습니다."
            : "The member can sign in again. Previously ended login sessions stay ended."
    }
    var suspendExplanation: String {
        isKorean
            ? "접근 권한이 즉시 중지되고 활성 로그인 세션이 종료됩니다."
            : "Access ends immediately and active login sessions are signed out."
    }
    var agentCredentialAfterRemoval: String {
        isKorean
            ? "이 에이전트를 복구하거나 다시 만들려면 새 자격 증명이 필요합니다. 폐기된 자격 증명은 복원할 수 없습니다."
            : "Reinstating or recreating this agent requires a new credential. Revoked credentials cannot be restored."
    }
    var reasonOptional: String { isKorean ? "사유(선택 사항)" : "Reason (optional)" }
    func blockFromRejoining(_ handle: String) -> String {
        isKorean ? "@\(handle)의 재가입 차단" : "Block @\(handle) from rejoining"
    }
    var removeExplanation: String {
        isKorean
            ? "워크스페이스 접근 권한과 활성 로그인 세션이 종료됩니다. 이 작업은 감사 로그에 기록됩니다."
            : "Workspace access and active login sessions end. This action is recorded in the audit log."
    }
    func removeTitle(_ name: String) -> String { isKorean ? "\(name)님 제거" : "Remove \(name)" }
    var remove: String { isKorean ? "제거" : "Remove" }
    var membershipUpdateFailed: String {
        isKorean ? "멤버 변경을 완료하지 못했습니다. 다시 시도해 주세요." : "The member update could not be completed. Try again."
    }

    var filters: String { isKorean ? "필터" : "Filters" }
    var action: String { isKorean ? "행위" : "Action" }
    var member: String { isKorean ? "멤버" : "Member" }
    var allMembers: String { isKorean ? "모든 멤버" : "All members" }
    var time: String { isKorean ? "기간" : "Time" }
    var applyFilters: String { isKorean ? "필터 적용" : "Apply filters" }
    var events: String { isKorean ? "이벤트" : "Events" }
    var loadingAuditLog: String { isKorean ? "감사 로그 불러오는 중" : "Loading audit log" }
    var noAuditEvents: String { isKorean ? "감사 이벤트가 없습니다." : "No audit events" }
    var loadMore: String { isKorean ? "더 불러오기" : "Load more" }
    var allActions: String { isKorean ? "모든 행위" : "All actions" }
    var memberLifecycle: String { isKorean ? "멤버 수명 주기" : "Member lifecycle" }
    var bans: String { isKorean ? "차단" : "Bans" }
    var allTime: String { isKorean ? "전체 기간" : "All time" }
    var hours24: String { isKorean ? "24시간" : "24 hours" }
    var days7: String { isKorean ? "7일" : "7 days" }
    var days30: String { isKorean ? "30일" : "30 days" }
    var unknownAuditActor: String { isKorean ? "알 수 없는 행위자" : "Unknown actor" }
    func actorTarget(actor: String, target: String?) -> String {
        guard let target else { return isKorean ? "행위자 \(actor)" : "Actor \(actor)" }
        return isKorean ? "행위자 \(actor) → 대상 \(target)" : "Actor \(actor) → Target \(target)"
    }
    func auditActionTitle(_ action: String) -> String {
        if isKorean {
            switch action {
            case "role.changed": return "역할 변경"
            case "member.suspended": return "멤버 일시 정지"
            case "member.reinstated": return "멤버 복구"
            case "member.removed": return "멤버 제거"
            case "ban.created": return "재가입 차단"
            case "ban.deleted": return "재가입 차단 해제"
            default: break
            }
        }
        return action.replacingOccurrences(of: ".", with: " ").capitalized
    }

    var membersAndAudit: String { isKorean ? "멤버 및 감사 로그" : "Members and audit" }
    var leaveWorkspace: String { isKorean ? "워크스페이스 나가기" : "Leave workspace" }
    func leaveWorkspaceQuestion(_ name: String) -> String { isKorean ? "\(name)에서 나갈까요?" : "Leave \(name)?" }
    var lastOwnerLeaveExplanation: String {
        isKorean
            ? "마지막 소유자라면 나가기 전에 다른 멤버를 소유자로 지정해야 합니다."
            : "If you are the last owner, assign another owner before leaving."
    }
    var leaveWorkspaceExplanation: String {
        isKorean
            ? "워크스페이스 멤버십이 해제되고 활성 로그인 세션이 종료됩니다."
            : "Your workspace membership ends and active login sessions are signed out."
    }
    var leaveWorkspaceFailed: String {
        isKorean ? "워크스페이스에서 나가지 못했습니다. 다시 시도해 주세요." : "Could not leave the workspace. Try again."
    }
    var leaveChannel: String { isKorean ? "채널 나가기" : "Leave channel" }
    func leaveChannelQuestion(_ name: String) -> String { isKorean ? "\(name) 채널에서 나갈까요?" : "Leave \(name)?" }
    func leaveChannelExplanation(_ name: String) -> String {
        isKorean ? "\(name) 채널의 메시지를 더 이상 받지 않습니다." : "You will stop receiving messages from \(name)."
    }
    var leaveChannelFailed: String {
        isKorean ? "채널에서 나가지 못했습니다. 다시 시도해 주세요." : "Could not leave the channel. Try again."
    }

    func roleTitle(_ role: MembershipRole?) -> String {
        switch (isKorean, role) {
        case (true, .owner): return "소유자"
        case (true, .admin): return "관리자"
        case (true, .guest): return "게스트"
        case (true, _): return "멤버"
        case (false, .owner): return "Owner"
        case (false, .admin): return "Admin"
        case (false, .guest): return "Guest"
        case (false, _): return "Member"
        }
    }

    func statusTitle(_ status: MemberStatus) -> String {
        switch (isKorean, status) {
        case (true, .active): return "활성"
        case (true, .invited): return "초대됨"
        case (true, .suspended): return "정지됨"
        case (true, .deleted): return "제거됨"
        case (false, .active): return "Active"
        case (false, .invited): return "Invited"
        case (false, .suspended): return "Suspended"
        case (false, .deleted): return "Removed"
        }
    }
}
