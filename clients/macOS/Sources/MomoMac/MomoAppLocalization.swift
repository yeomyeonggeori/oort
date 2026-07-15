import SwiftUI
import MomoCore

public extension MomoUILanguage {
    static let appStorageKey = "momo.ui.language"
}

enum MomoKoreanParticle {
    enum Pair {
        case subject
        case object
        case topic

        fileprivate var particles: (withFinalConsonant: String, withoutFinalConsonant: String) {
            switch self {
            case .subject:
                return ("이", "가")
            case .object:
                return ("을", "를")
            case .topic:
                return ("은", "는")
            }
        }
    }

    static func attach(_ pair: Pair, to word: String) -> String {
        let particles = pair.particles
        return word + (hasFinalConsonant(word)
            ? particles.withFinalConsonant
            : particles.withoutFinalConsonant)
    }

    private static func hasFinalConsonant(_ word: String) -> Bool {
        let ignoredAtEnd = CharacterSet.whitespacesAndNewlines
            .union(.punctuationCharacters)
        guard let scalar = word.unicodeScalars.reversed().first(where: {
            !ignoredAtEnd.contains($0)
        }), (0xAC00...0xD7A3).contains(scalar.value) else {
            return false
        }
        return (scalar.value - 0xAC00).isMultiple(of: 28) == false
    }
}

struct MomoWorkspaceCopy {
    var language: MomoUILanguage

    var languageLabel: String {
        switch language {
        case .korean: return "언어"
        case .english: return "Language"
        }
    }

    var appearanceLabel: String {
        switch language {
        case .korean: return "화면 모드"
        case .english: return "Appearance"
        }
    }

    var appearanceSystem: String {
        switch language {
        case .korean: return "시스템 설정"
        case .english: return "System"
        }
    }

    var appearanceLight: String {
        switch language {
        case .korean: return "라이트 모드"
        case .english: return "Light"
        }
    }

    var appearanceDark: String {
        switch language {
        case .korean: return "다크 모드"
        case .english: return "Dark"
        }
    }

    var quickStartTitle: String {
        switch language {
        case .korean: return "처음이라면 이렇게 시작하세요"
        case .english: return "Start here"
        }
    }

    var quickStartSubtitle: String {
        switch language {
        case .korean: return "채널에서 메시지를 보내고, 초대한 에이전트를 별칭으로 호출하고, 필요한 승인/상태만 확인하세요."
        case .english: return "Send a message, call an invited agent by alias, and open approvals/status only when needed."
        }
    }

    var insertAgentMention: String {
        switch language {
        case .korean: return "에이전트 호출"
        case .english: return "Mention agent"
        }
    }

    var draftSummaryPrompt: String {
        switch language {
        case .korean: return "요약 요청 넣기"
        case .english: return "Draft summary ask"
        }
    }

    var dismissGuide: String {
        switch language {
        case .korean: return "가이드 닫기"
        case .english: return "Dismiss guide"
        }
    }

    var guideStepChannel: String {
        switch language {
        case .korean: return "채널 선택"
        case .english: return "Pick a channel"
        }
    }

    var guideStepAgent: String {
        switch language {
        case .korean: return "에이전트 멘션"
        case .english: return "Mention an agent"
        }
    }

    var guideStepApproval: String {
        switch language {
        case .korean: return "승인/비용 확인"
        case .english: return "Review approvals/cost"
        }
    }

    var guideSummaryPromptText: String {
        switch language {
        case .korean: return "@hermes 이 채널에서 지금까지 결정된 내용과 다음 액션을 요약해줘."
        case .english: return "@hermes summarize the decisions and next actions in this channel."
        }
    }

    var selectChannel: String {
        switch language {
        case .korean: return "채널을 선택하세요"
        case .english: return "Select a channel"
        }
    }

    var messagePlaceholder: String {
        switch language {
        case .korean: return "메시지 입력, 또는 @에이전트 호출..."
        case .english: return "Message, or mention @agent..."
        }
    }

    var timelineEmptyTitle: String {
        switch language {
        case .korean: return "첫 메시지를 보내보세요"
        case .english: return "Send the first message"
        }
    }

    var timelineEmptyAction: String {
        switch language {
        case .korean: return "메시지 작성하기"
        case .english: return "Write a message"
        }
    }

    var timelineLoading: String {
        switch language {
        case .korean: return "메시지 기록 불러오는 중"
        case .english: return "Loading message history"
        }
    }

    var messageSending: String {
        switch language {
        case .korean: return "전송 중"
        case .english: return "Sending"
        }
    }

    var copyMessage: String {
        switch language {
        case .korean: return "메시지 복사"
        case .english: return "Copy message"
        }
    }

    var mentionAutocompleteTitle: String {
        switch language {
        case .korean: return "멘션할 멤버"
        case .english: return "Mention"
        }
    }

    func typingIndicator(_ names: [String]) -> String {
        let visible = names.prefix(2).joined(separator: ", ")
        let remainder = max(0, names.count - 2)
        switch language {
        case .korean:
            if remainder > 0 {
                return "\(visible) 외 \(remainder)명이 입력 중..."
            }
            return "\(MomoKoreanParticle.attach(.subject, to: visible)) 입력 중..."
        case .english:
            if remainder > 0 {
                return "\(visible) and \(remainder) more are typing..."
            }
            return names.count == 1 ? "\(visible) is typing..." : "\(visible) are typing..."
        }
    }

    func agentWorkingTitle(_ name: String) -> String {
        switch language {
        case .korean: return "\(MomoKoreanParticle.attach(.subject, to: name)) 작업 중"
        case .english: return "\(name) is working"
        }
    }

    var agentWorkingSubtitle: String {
        switch language {
        case .korean: return "응답이 준비되면 같은 채널 타임라인에 표시됩니다."
        case .english: return "The response will appear in this channel timeline."
        }
    }

    var workspace: String {
        switch language {
        case .korean: return "워크스페이스"
        case .english: return "Workspace"
        }
    }

    var readyToChat: String {
        switch language {
        case .korean: return "메시지를 보내거나 에이전트를 호출해보세요"
        case .english: return "Send a message or mention an agent"
        }
    }

    var localAI: String {
        switch language {
        case .korean: return "로컬 AI"
        case .english: return "Local AI"
        }
    }

    var workQueue: String {
        switch language {
        case .korean: return "작업함"
        case .english: return "Work"
        }
    }

    var approvalRequests: String {
        switch language {
        case .korean: return "승인 요청"
        case .english: return "Approval requests"
        }
    }

    var agentApprovalInbox: String {
        switch language {
        case .korean: return "에이전트 승인함"
        case .english: return "Agent approvals"
        }
    }

    var noPendingApprovals: String {
        switch language {
        case .korean: return "대기 중인 승인 없음"
        case .english: return "No pending approvals"
        }
    }

    var noPendingAgentApprovals: String {
        switch language {
        case .korean: return "외부 작업 전 확인할 요청 없음"
        case .english: return "No external actions need review"
        }
    }

    var agentApprovalInboxSubtitle: String {
        switch language {
        case .korean: return "에이전트가 외부 작업을 하기 전 확인이 필요한 요청입니다."
        case .english: return "Requests that need review before an agent performs external work."
        }
    }

    var pendingApprovals: String {
        switch language {
        case .korean: return "개 대기"
        case .english: return "pending"
        }
    }

    var channels: String {
        switch language {
        case .korean: return "채널"
        case .english: return "Channels"
        }
    }

    var channelSettings: String {
        switch language {
        case .korean: return "채널 설정"
        case .english: return "Channel settings"
        }
    }

    var inviteToChannel: String {
        switch language {
        case .korean: return "채널에 멤버 추가"
        case .english: return "Add members to channel"
        }
    }

    var channelNotificationsPlanned: String {
        switch language {
        case .korean: return "채널 알림은 준비 중"
        case .english: return "Channel notifications coming later"
        }
    }

    var copyChannelID: String {
        switch language {
        case .korean: return "채널 ID 복사"
        case .english: return "Copy channel ID"
        }
    }

    var channelSettingsSubtitle: String {
        switch language {
        case .korean: return "채널 표시, 멤버, 연동을 관리합니다."
        case .english: return "Manage channel display, members, and integrations."
        }
    }

    var channelIdentity: String {
        switch language {
        case .korean: return "이름과 주제"
        case .english: return "Name and topic"
        }
    }

    func channelMemberCount(_ count: Int) -> String {
        switch language {
        case .korean: return "멤버 \(count)명"
        case .english: return count == 1 ? "1 member" : "\(count) members"
        }
    }

    var openMemberDirectory: String {
        switch language {
        case .korean: return "멤버 목록 열기"
        case .english: return "Open member directory"
        }
    }

    var workspaceSearch: String {
        switch language {
        case .korean: return "워크스페이스 검색"
        case .english: return "Workspace search"
        }
    }

    var workspaceSearchUnavailableTitle: String {
        switch language {
        case .korean: return "워크스페이스 검색을 준비 중입니다"
        case .english: return "Workspace search is coming later"
        }
    }

    var workspaceSearchUnavailableDetail: String {
        switch language {
        case .korean: return "이 빌드에는 서버 메시지 검색이 없습니다. 퀵 스위처에서는 현재 채널과 멤버만 찾을 수 있습니다."
        case .english: return "This build does not include server message search. Quick switcher only finds loaded channels and members."
        }
    }

    var openQuickSwitcher: String {
        switch language {
        case .korean: return "퀵 스위처 열기"
        case .english: return "Open quick switcher"
        }
    }

    var appDownloads: String {
        switch language {
        case .korean: return "앱 다운로드와 업데이트"
        case .english: return "App downloads and updates"
        }
    }

    var channelMemberManagement: String {
        switch language {
        case .korean: return "채널 멤버"
        case .english: return "Channel members"
        }
    }

    var channelMemberManagementSubtitle: String {
        switch language {
        case .korean: return "이 채널에서 대화할 멤버와 에이전트를 선택합니다."
        case .english: return "Choose the people and agents who can participate in this channel."
        }
    }

    var channelMembershipUnavailable: String {
        switch language {
        case .korean: return "멤버 변경을 완료하지 못했습니다. 연결을 확인하고 다시 선택하세요."
        case .english: return "Member changes could not be completed. Check the connection and select again."
        }
    }

    var noWorkspaceMembers: String {
        switch language {
        case .korean: return "추가할 워크스페이스 멤버가 없습니다."
        case .english: return "There are no workspace members to add."
        }
    }

    var integrations: String {
        switch language {
        case .korean: return "연동"
        case .english: return "Integrations"
        }
    }

    var webhooks: String {
        switch language {
        case .korean: return "웹훅"
        case .english: return "Webhooks"
        }
    }

    var inboundWebhook: String {
        switch language {
        case .korean: return "인바운드 웹훅"
        case .english: return "Inbound webhook"
        }
    }

    var webhookPlaceholderDetail: String {
        switch language {
        case .korean: return "이 워크스페이스에서는 아직 웹훅을 사용할 수 없습니다."
        case .english: return "Webhooks are not available in this workspace yet."
        }
    }

    var saveChannelSettings: String {
        switch language {
        case .korean: return "이 Mac에 저장"
        case .english: return "Save on this Mac"
        }
    }

    var channelLocalDraftNote: String {
        switch language {
        case .korean: return "이름과 주제는 이 Mac에서만 보입니다. 다른 기기에는 반영되지 않습니다."
        case .english: return "Name and topic appear only on this Mac and are not synced to other devices."
        }
    }

    var channelSettingsSavedLocally: String {
        switch language {
        case .korean: return "이 Mac에 채널 표시를 저장했습니다."
        case .english: return "Channel display saved on this Mac."
        }
    }

    var characterCount: String {
        switch language {
        case .korean: return "글자 수"
        case .english: return "Characters"
        }
    }

    var directMessages: String {
        switch language {
        case .korean: return "다이렉트 메시지"
        case .english: return "Direct messages"
        }
    }

    var approvals: String {
        switch language {
        case .korean: return "승인"
        case .english: return "Approvals"
        }
    }

    var members: String {
        switch language {
        case .korean: return "멤버"
        case .english: return "Members"
        }
    }

    var memberDirectory: String {
        switch language {
        case .korean: return "멤버 디렉터리"
        case .english: return "Member directory"
        }
    }

    var currentChannelMembers: String {
        switch language {
        case .korean: return "현재 채널 멤버"
        case .english: return "Current channel members"
        }
    }

    var workspaceMembers: String {
        switch language {
        case .korean: return "워크스페이스 멤버"
        case .english: return "Workspace members"
        }
    }

    var closeMemberInspector: String {
        switch language {
        case .korean: return "멤버 목록 닫기"
        case .english: return "Close member list"
        }
    }

    var browseMembers: String {
        switch language {
        case .korean: return "전체 멤버 보기"
        case .english: return "Browse all members"
        }
    }

    var allMembers: String {
        switch language {
        case .korean: return "전체"
        case .english: return "All"
        }
    }

    var people: String {
        switch language {
        case .korean: return "사람"
        case .english: return "People"
        }
    }

    var searchMembers: String {
        switch language {
        case .korean: return "이름 또는 핸들 검색"
        case .english: return "Search names or handles"
        }
    }

    var noDirectoryMembers: String {
        switch language {
        case .korean: return "표시할 멤버가 없습니다"
        case .english: return "No members to show"
        }
    }

    var noDirectoryMembersDetail: String {
        switch language {
        case .korean: return "워크스페이스에 참여한 멤버가 여기에 표시됩니다"
        case .english: return "Members appear here after they join the workspace"
        }
    }

    var noMemberSearchResults: String {
        switch language {
        case .korean: return "일치하는 멤버가 없습니다"
        case .english: return "No matching members"
        }
    }

    var clearMemberSearch: String {
        switch language {
        case .korean: return "검색 지우기"
        case .english: return "Clear search"
        }
    }

    var showAllMembers: String {
        switch language {
        case .korean: return "전체 멤버 보기"
        case .english: return "Show all members"
        }
    }

    var loadingMembers: String {
        switch language {
        case .korean: return "멤버 불러오는 중"
        case .english: return "Loading members"
        }
    }

    var memberLoadFailed: String {
        switch language {
        case .korean: return "멤버를 불러오지 못했습니다"
        case .english: return "Members could not be loaded"
        }
    }

    var memberDirectoryOffline: String {
        switch language {
        case .korean: return "오프라인 상태입니다. 저장된 멤버를 표시합니다."
        case .english: return "You are offline. Showing saved members."
        }
    }

    var sendDirectMessage: String {
        switch language {
        case .korean: return "DM 보내기"
        case .english: return "Send a DM"
        }
    }

    var openingDirectMessage: String {
        switch language {
        case .korean: return "DM 여는 중"
        case .english: return "Opening DM"
        }
    }

    var newDirectMessage: String {
        switch language {
        case .korean: return "새 DM 시작"
        case .english: return "Start a new DM"
        }
    }

    var directMessageFailed: String {
        switch language {
        case .korean: return "DM을 시작하지 못했습니다. 연결을 확인하고 다시 시도하세요."
        case .english: return "The DM could not be started. Check the connection and try again."
        }
    }

    var directMessageSelfUnavailable: String {
        switch language {
        case .korean: return "내 프로필입니다. 자신에게는 DM을 보낼 수 없습니다."
        case .english: return "This is your profile. You cannot send a DM to yourself."
        }
    }

    var directMessageInactiveUnavailable: String {
        switch language {
        case .korean: return "활성 상태인 멤버에게만 DM을 보낼 수 있습니다."
        case .english: return "You can send DMs only to active members."
        }
    }

    var copyMemberHandle: String {
        switch language {
        case .korean: return "핸들 복사"
        case .english: return "Copy handle"
        }
    }

    var mentionMember: String {
        switch language {
        case .korean: return "채널에서 멘션"
        case .english: return "Mention in channel"
        }
    }

    var profileActions: String {
        switch language {
        case .korean: return "프로필 작업"
        case .english: return "Profile actions"
        }
    }

    var memberType: String {
        switch language {
        case .korean: return "유형"
        case .english: return "Type"
        }
    }

    var memberRole: String {
        switch language {
        case .korean: return "역할"
        case .english: return "Role"
        }
    }

    var memberHandle: String {
        switch language {
        case .korean: return "핸들"
        case .english: return "Handle"
        }
    }

    var selectMemberProfile: String {
        switch language {
        case .korean: return "프로필을 볼 멤버를 선택하세요"
        case .english: return "Select a member to view their profile"
        }
    }

    func workspaceRoleTitle(_ role: MembershipRole?) -> String {
        switch (language, role) {
        case (.korean, .owner): return "소유자"
        case (.korean, .admin): return "관리자"
        case (.korean, .guest): return "게스트"
        case (.korean, _): return "멤버"
        case (.english, .owner): return "Owner"
        case (.english, .admin): return "Admin"
        case (.english, .guest): return "Guest"
        case (.english, _): return "Member"
        }
    }

    func memberStatusTitle(_ status: MemberStatus) -> String {
        switch (language, status) {
        case (.korean, .active): return "활성"
        case (.korean, .invited): return "초대됨"
        case (.korean, .suspended): return "정지됨"
        case (.korean, .deleted): return "삭제됨"
        case (.english, .active): return "Active"
        case (.english, .invited): return "Invited"
        case (.english, .suspended): return "Suspended"
        case (.english, .deleted): return "Deleted"
        }
    }

    var addToChannel: String {
        switch language {
        case .korean: return "채널에 추가"
        case .english: return "Add to channel"
        }
    }

    var removeFromChannel: String {
        switch language {
        case .korean: return "채널에서 제거"
        case .english: return "Remove from channel"
        }
    }

    var agents: String {
        switch language {
        case .korean: return "에이전트"
        case .english: return "Agents"
        }
    }

    var inviteAgent: String {
        switch language {
        case .korean: return "에이전트 초대"
        case .english: return "Invite agent"
        }
    }

    var inviteMembers: String {
        switch language {
        case .korean: return "멤버 초대"
        case .english: return "Invite members"
        }
    }

    var inviteMembersSubtitle: String {
        switch language {
        case .korean: return "사람 또는 로컬 에이전트를 이 워크스페이스에 초대합니다."
        case .english: return "Invite a person or a local agent into this workspace."
        }
    }

    var inviteType: String {
        switch language {
        case .korean: return "초대 유형"
        case .english: return "Invite type"
        }
    }

    var human: String {
        switch language {
        case .korean: return "사람"
        case .english: return "Person"
        }
    }

    var agent: String {
        switch language {
        case .korean: return "에이전트"
        case .english: return "Agent"
        }
    }

    var humanInviteTitle: String {
        switch language {
        case .korean: return "사람 멤버 초대"
        case .english: return "Invite a person"
        }
    }

    var humanInviteBody: String {
        switch language {
        case .korean: return "초대 코드를 만들고 팀원에게 공유합니다. 참가한 멤버는 채널별로 추가하거나 제거할 수 있습니다."
        case .english: return "Create an invite code and share it with a teammate. Joined members can then be added to channels."
        }
    }

    var openInviteCodes: String {
        switch language {
        case .korean: return "초대 코드 관리"
        case .english: return "Manage invite codes"
        }
    }

    var inviteGuidanceTitle: String {
        switch language {
        case .korean: return "초대 코드 안내"
        case .english: return "Invite code guidance"
        }
    }

    var inviteGuidanceBody: String {
        switch language {
        case .korean: return "이 세션에서는 초대 코드를 관리할 수 없습니다. 워크스페이스 관리자 계정으로 다시 로그인한 뒤 멤버 초대에서 코드를 만들고 공유하세요."
        case .english: return "Invite codes are unavailable in this session. Sign in with a workspace admin account, then create and share a code from Invite members."
        }
    }

    var agentInviteTitle: String {
        switch language {
        case .korean: return "로컬 에이전트 초대"
        case .english: return "Invite a local agent"
        }
    }

    var agentInviteBody: String {
        switch language {
        case .korean: return "로컬 Hermes gateway가 momo와 통신할 pairing manifest를 만들고, 이 채널에 에이전트를 초대합니다."
        case .english: return "Create a pairing manifest for the local Hermes gateway, then invite the agent into this channel."
        }
    }

    var agentDisplayName: String {
        switch language {
        case .korean: return "표시 이름"
        case .english: return "Display name"
        }
    }

    var completeAgentInvite: String {
        switch language {
        case .korean: return "에이전트 초대 완료"
        case .english: return "Complete agent invite"
        }
    }

    var updateAgentProfile: String {
        switch language {
        case .korean: return "에이전트 프로필 저장"
        case .english: return "Save agent profile"
        }
    }

    var agentAliasRequired: String {
        switch language {
        case .korean: return "에이전트 별칭이 필요합니다."
        case .english: return "Agent alias is required."
        }
    }

    var agentAlias: String {
        switch language {
        case .korean: return "호출 별칭 예: @hermes"
        case .english: return "Call alias, e.g. @hermes"
        }
    }

    var handleLabel: String {
        switch language {
        case .korean: return "핸들"
        case .english: return "Handle"
        }
    }

    var providerEndpoint: String {
        switch language {
        case .korean: return "연결 endpoint"
        case .english: return "Provider endpoint"
        }
    }

    var modelLabel: String {
        switch language {
        case .korean: return "모델 라벨"
        case .english: return "Model label"
        }
    }

    var permissionScope: String {
        switch language {
        case .korean: return "권한 범위"
        case .english: return "Permission scope"
        }
    }

    func pairingScopeTitle(_ scope: MomoAgentPairingPermissionScope) -> String {
        switch (language, scope) {
        case (.korean, .channelReadReply): return "채널 읽기 + 답변"
        case (.english, .channelReadReply): return "Read channel + reply"
        case (.korean, .channelReadReplyApprovalTools): return "채널 읽기 + 답변 + 승인형 도구"
        case (.english, .channelReadReplyApprovalTools): return "Read/reply + approval-gated tools"
        }
    }

    func pairingScopeDetail(_ scope: MomoAgentPairingPermissionScope) -> String {
        switch (language, scope) {
        case (.korean, .channelReadReply):
            return "선택한 채널 컨텍스트를 읽고 같은 타임라인에 답변합니다."
        case (.english, .channelReadReply):
            return "Reads selected-channel context and replies in the same timeline."
        case (.korean, .channelReadReplyApprovalTools):
            return "외부 쓰기 작업은 승인 카드 뒤에서만 실행합니다."
        case (.english, .channelReadReplyApprovalTools):
            return "External writes must pause behind approval cards."
        }
    }

    var agentInviteNetworkNote: String {
        switch language {
        case .korean: return "momo는 provider OAuth/token을 저장하지 않습니다. 토큰은 Hermes/provider 런타임 안에만 둡니다."
        case .english: return "momo does not store provider OAuth tokens. Credentials stay inside the Hermes/provider runtime."
        }
    }

    var pairingManifest: String {
        switch language {
        case .korean: return "Pairing manifest"
        case .english: return "Pairing manifest"
        }
    }

    var pairingInviteCode: String {
        switch language {
        case .korean: return "초대 코드"
        case .english: return "Invite code"
        }
    }

    var copyManifest: String {
        switch language {
        case .korean: return "manifest 복사"
        case .english: return "Copy manifest"
        }
    }

    var exportManifest: String {
        switch language {
        case .korean: return "JSON 내보내기"
        case .english: return "Export JSON"
        }
    }

    var copyInviteCode: String {
        switch language {
        case .korean: return "코드 복사"
        case .english: return "Copy code"
        }
    }

    var manifestCopied: String {
        switch language {
        case .korean: return "Pairing manifest를 클립보드에 복사했습니다."
        case .english: return "Pairing manifest copied to the clipboard."
        }
    }

    var inviteCodeCopied: String {
        switch language {
        case .korean: return "에이전트 초대 코드를 클립보드에 복사했습니다."
        case .english: return "Agent invite code copied to the clipboard."
        }
    }

    var nonLoopbackHTTPOptIn: String {
        switch language {
        case .korean: return "비-loopback HTTP endpoint를 명시적으로 허용"
        case .english: return "Explicitly allow non-loopback HTTP endpoint"
        }
    }

    var pairingEndpointBlocked: String {
        switch language {
        case .korean: return "보안상 기본값은 로컬 loopback endpoint만 허용합니다."
        case .english: return "For safety, the default only allows local loopback endpoints."
        }
    }

    var agentPairingChecklist: String {
        switch language {
        case .korean: return "연결 체크리스트"
        case .english: return "Pairing checklist"
        }
    }

    var pairingStepProvider: String {
        switch language {
        case .korean: return "provider 실행"
        case .english: return "Start provider"
        }
    }

    var pairingStepOAuth: String {
        switch language {
        case .korean: return "OAuth 완료"
        case .english: return "Finish OAuth"
        }
    }

    var pairingStepValues: String {
        switch language {
        case .korean: return "pairing 값 입력"
        case .english: return "Enter pairing values"
        }
    }

    var pairingStepSmoke: String {
        switch language {
        case .korean: return "smoke 실행"
        case .english: return "Run smoke"
        }
    }

    var runbookReference: String {
        switch language {
        case .korean: return "런북: scripts/momo hermes-gateway-init/status/smoke"
        case .english: return "Runbook: scripts/momo hermes-gateway-init/status/smoke"
        }
    }

    var prepareAgentInvite: String {
        switch language {
        case .korean: return "에이전트 연결 준비"
        case .english: return "Prepare agent connection"
        }
    }

    var agentNotInvitedStatus: String {
        switch language {
        case .korean: return "아직 이 워크스페이스에 초대되지 않았습니다."
        case .english: return "Not invited into this workspace yet."
        }
    }

    func agentInvitedStatus(alias: String) -> String {
        switch language {
        case .korean: return "\(alias)로 이 채널에서 호출할 수 있습니다."
        case .english: return "Callable in this channel as \(alias)."
        }
    }

    var noMembersInChannel: String {
        switch language {
        case .korean: return "이 채널에 표시할 멤버가 없습니다"
        case .english: return "No members in this channel"
        }
    }

    var hermesRuntime: String {
        switch language {
        case .korean: return "에르메스 런타임"
        case .english: return "Hermes runtime"
        }
    }

    var diagnostics: String {
        switch language {
        case .korean: return "진단"
        case .english: return "Diagnostics"
        }
    }

    var developerTools: String {
        switch language {
        case .korean: return "개발 도구"
        case .english: return "Developer tools"
        }
    }

    var developerToolsSubtitle: String {
        switch language {
        case .korean: return "연결, 로컬 AI, 컨텍스트 상태"
        case .english: return "Connection, local AI, context status"
        }
    }

    var profile: String {
        switch language {
        case .korean: return "프로필"
        case .english: return "Profile"
        }
    }

    var profileSettingsSubtitle: String {
        switch language {
        case .korean: return "이름과 프로필 이미지를 관리합니다."
        case .english: return "Manage your name and profile image."
        }
    }

    var memberProfile: String {
        switch language {
        case .korean: return "멤버 프로필"
        case .english: return "Member profile"
        }
    }

    var agentProfile: String {
        switch language {
        case .korean: return "에이전트 프로필"
        case .english: return "Agent profile"
        }
    }

    var memberProfileSettingsSubtitle: String {
        switch language {
        case .korean: return "표시 이름, 이미지, 상태 뱃지를 로컬 dogfood 표시값으로 관리합니다."
        case .english: return "Manage display name, image, and status badge as a local dogfood display value."
        }
    }

    var memberProfileMissingSubtitle: String {
        switch language {
        case .korean: return "프로필을 편집할 멤버를 왼쪽 목록에서 선택하세요."
        case .english: return "Select a member from the left roster to edit a profile."
        }
    }

    var editProfile: String {
        switch language {
        case .korean: return "프로필 편집"
        case .english: return "Edit profile"
        }
    }

    var serverManagedProfileNote: String {
        switch language {
        case .korean: return "프로필은 서버 멤버 목록에서 관리됩니다. 이 앱에서는 아직 편집할 수 없습니다."
        case .english: return "Profiles are managed by the server member directory. Editing is not available in this app yet."
        }
    }

    var saveProfile: String {
        switch language {
        case .korean: return "프로필 저장"
        case .english: return "Save profile"
        }
    }

    var displayName: String {
        switch language {
        case .korean: return "표시 이름"
        case .english: return "Display name"
        }
    }

    var profileImage: String {
        switch language {
        case .korean: return "프로필 이미지"
        case .english: return "Profile image"
        }
    }

    var profileLocalDraftNote: String {
        switch language {
        case .korean: return "현재 dogfood 앱에서는 로컬 표시값으로 저장됩니다. 서버 프로필 API는 후속 goal에서 연결합니다."
        case .english: return "For this dogfood app, this is saved as a local display value. Server profile persistence follows in a later goal."
        }
    }

    var settings: String {
        switch language {
        case .korean: return "설정"
        case .english: return "Settings"
        }
    }

    var settingsSubtitle: String {
        switch language {
        case .korean: return "언어, 화면 모드, 개발자 표시를 관리합니다."
        case .english: return "Manage language, appearance, and developer visibility."
        }
    }

    var general: String {
        switch language {
        case .korean: return "일반"
        case .english: return "General"
        }
    }

    var developerMode: String {
        switch language {
        case .korean: return "개발자 모드"
        case .english: return "Developer mode"
        }
    }

    var developerModeSubtitle: String {
        switch language {
        case .korean: return "실행 세부 정보, 프로토콜 메타데이터, 진단 도구를 표시합니다."
        case .english: return "Show execution details, protocol metadata, and diagnostic tools."
        }
    }

    var showCosts: String {
        switch language {
        case .korean: return "비용 표시"
        case .english: return "Show costs"
        }
    }

    var showCostsSubtitle: String {
        switch language {
        case .korean: return "메시지별 비용 링과 채널 누적 금액을 표시합니다."
        case .english: return "Show per-message cost rings and the channel total."
        }
    }

    func agentActivityFallback(_ type: MessageType, agentName: String) -> String {
        switch (language, type) {
        case (.korean, .toolCall): return "\(MomoKoreanParticle.attach(.subject, to: agentName)) 작업을 시작했습니다."
        case (.korean, .toolResult): return "\(MomoKoreanParticle.attach(.subject, to: agentName)) 작업을 마쳤습니다."
        case (.korean, .diff): return "\(MomoKoreanParticle.attach(.subject, to: agentName)) 변경 내용을 준비했습니다."
        case (.korean, .approvalRequest): return "\(MomoKoreanParticle.attach(.subject, to: agentName)) 작업 승인을 요청했습니다."
        case (.korean, .artifact): return "\(MomoKoreanParticle.attach(.subject, to: agentName)) 결과물을 첨부했습니다."
        case (.korean, .text), (.korean, .system): return "\(MomoKoreanParticle.attach(.subject, to: agentName)) 메시지를 남겼습니다."
        case (.english, .toolCall): return "\(agentName) started a task."
        case (.english, .toolResult): return "\(agentName) finished a task."
        case (.english, .diff): return "\(agentName) prepared a change."
        case (.english, .approvalRequest): return "\(agentName) requested approval."
        case (.english, .artifact): return "\(agentName) attached a result."
        case (.english, .text), (.english, .system): return "\(agentName) posted a message."
        }
    }

    func agentActivitySummary(agentName: String, detail: String) -> String {
        switch language {
        case .korean: return "\(agentName): \(detail)"
        case .english: return "\(agentName): \(detail)"
        }
    }

    var email: String {
        switch language {
        case .korean: return "이메일"
        case .english: return "Email"
        }
    }

    var session: String {
        switch language {
        case .korean: return "세션"
        case .english: return "Session"
        }
    }

    var workspaceAppearance: String {
        switch language {
        case .korean: return "워크스페이스 프로필"
        case .english: return "Workspace profile"
        }
    }

    var serverSettings: String {
        switch language {
        case .korean: return "워크스페이스 설정"
        case .english: return "Workspace settings"
        }
    }

    var workspaceLabel: String {
        switch language {
        case .korean: return "워크스페이스"
        case .english: return "Workspace"
        }
    }

    func workspaceSignedInAs(_ displayName: String) -> String {
        switch language {
        case .korean: return "현재 사용자 · \(displayName)"
        case .english: return "Current user · \(displayName)"
        }
    }

    var workspaceMenu: String {
        switch language {
        case .korean: return "워크스페이스 메뉴"
        case .english: return "Workspace menu"
        }
    }

    var copyWorkspaceID: String {
        switch language {
        case .korean: return "워크스페이스 ID 복사"
        case .english: return "Copy workspace ID"
        }
    }

    var serverSettingsSubtitle: String {
        switch language {
        case .korean: return "워크스페이스 이름과 이 Mac의 표시 설정을 관리합니다."
        case .english: return "Manage the workspace name and display settings on this Mac."
        }
    }

    var saveWorkspaceName: String {
        switch language {
        case .korean: return "이름 저장"
        case .english: return "Save name"
        }
    }

    var workspaceNameSaved: String {
        switch language {
        case .korean: return "워크스페이스에 저장됨"
        case .english: return "Saved to workspace"
        }
    }

    var workspaceNameSaveFailed: String {
        switch language {
        case .korean: return "이름을 저장하지 못했습니다. 권한과 연결을 확인하세요."
        case .english: return "Could not save the name. Check your access and connection."
        }
    }

    var workspaceCachedRetry: String {
        switch language {
        case .korean: return "저장된 이름 · 다시 확인"
        case .english: return "Saved name · Retry"
        }
    }

    var workspaceCachedHelp: String {
        switch language {
        case .korean: return "서버에서 워크스페이스 이름을 불러오지 못했습니다. 클릭하거나 Shift-Command-R을 눌러 다시 시도합니다."
        case .english: return "The workspace name could not be refreshed. Click or press Shift-Command-R to retry."
        }
    }

    var workspaceUnavailableRetry: String {
        switch language {
        case .korean: return "워크스페이스 오류 · 다시 시도"
        case .english: return "Workspace unavailable · Retry"
        }
    }

    var workspaceUnavailableHelp: String {
        switch language {
        case .korean: return "워크스페이스 정보를 불러오지 못했습니다. 클릭하거나 Shift-Command-R을 눌러 다시 시도합니다."
        case .english: return "Workspace information could not be loaded. Click or press Shift-Command-R to retry."
        }
    }

    var workspaceEditingRequiresAdmin: String {
        switch language {
        case .korean: return "소유자 또는 관리자만 워크스페이스 이름을 변경할 수 있습니다."
        case .english: return "Only owners and admins can change the workspace name."
        }
    }

    func workspaceNameLimit(_ count: Int) -> String {
        switch language {
        case .korean: return "1-80자 · 현재 \(count)자"
        case .english: return "1-80 characters · \(count) entered"
        }
    }

    func workspaceNameUpdateMessage(_ issue: WorkspaceNameUpdateIssue?) -> String {
        switch (language, issue) {
        case (.korean, .invalidName): return "이름은 제어 문자를 제외한 1-80자로 입력하세요."
        case (.english, .invalidName): return "Use 1-80 characters without control characters."
        case (.korean, .conflict): return "다른 곳에서 이름이 변경되었습니다. 최신 이름을 확인한 뒤 다시 시도하세요."
        case (.english, .conflict): return "The name changed elsewhere. Refresh it, then try again."
        case (.korean, .authenticationExpired): return "로그인이 만료되었습니다. 다시 로그인한 뒤 이름 변경을 시도하세요."
        case (.english, .authenticationExpired): return "Your session expired. Sign in again before renaming the workspace."
        case (.korean, .forbidden): return "이름을 변경할 권한이 없습니다. 소유자 또는 관리자에게 요청하세요."
        case (.english, .forbidden): return "You do not have permission to rename this workspace. Ask an owner or admin."
        case (.korean, .connection): return "서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도하세요."
        case (.english, .connection): return "Could not reach the server. Check your connection and try again."
        case (.korean, .reloadRequired): return "최신 워크스페이스 정보를 다시 불러온 뒤 시도하세요."
        case (.english, .reloadRequired): return "Refresh the workspace information, then try again."
        case (.korean, .unavailable), (.korean, nil): return workspaceNameSaveFailed
        case (.english, .unavailable), (.english, nil): return workspaceNameSaveFailed
        }
    }

    var serverName: String {
        switch language {
        case .korean: return "워크스페이스 이름"
        case .english: return "Workspace name"
        }
    }

    var serverIconText: String {
        switch language {
        case .korean: return "아이콘 문자"
        case .english: return "Icon text"
        }
    }

    var serverIconImage: String {
        switch language {
        case .korean: return "워크스페이스 아이콘"
        case .english: return "Workspace icon"
        }
    }

    var chooseImage: String {
        switch language {
        case .korean: return "이미지 선택"
        case .english: return "Choose image"
        }
    }

    var removeImage: String {
        switch language {
        case .korean: return "기본으로 되돌리기"
        case .english: return "Use default"
        }
    }

    var memberInvitePolicy: String {
        switch language {
        case .korean: return "멤버 초대 권한"
        case .english: return "Member invite policy"
        }
    }

    var invitePolicyAdmins: String {
        switch language {
        case .korean: return "관리자만"
        case .english: return "Admins only"
        }
    }

    var invitePolicyMembers: String {
        switch language {
        case .korean: return "모든 멤버"
        case .english: return "All members"
        }
    }

    var invitePolicyLocked: String {
        switch language {
        case .korean: return "초대 잠금"
        case .english: return "Invites locked"
        }
    }

    var agentInviteRequiresApproval: String {
        switch language {
        case .korean: return "에이전트 초대는 승인 필요"
        case .english: return "Agent invites require approval"
        }
    }

    var serverSettingsLocalDraftNote: String {
        switch language {
        case .korean: return "아이콘과 초대 설정은 현재 이 Mac에만 저장됩니다."
        case .english: return "The icon and invite settings are currently saved only on this Mac."
        }
    }

    var workspaceSettingsPersistenceNote: String {
        switch language {
        case .korean: return "워크스페이스 이름은 모든 멤버에게 적용됩니다. 아이콘과 초대 설정은 현재 이 Mac에만 저장됩니다."
        case .english: return "The workspace name applies to every member. The icon and invite settings are currently saved only on this Mac."
        }
    }

    var done: String {
        switch language {
        case .korean: return "완료"
        case .english: return "Done"
        }
    }

    var noChannels: String {
        switch language {
        case .korean: return "채널을 만들어 시작하세요"
        case .english: return "Create a channel to get started"
        }
    }

    var noDirectMessages: String {
        switch language {
        case .korean: return "대화가 시작되면 여기에 표시됩니다"
        case .english: return "Conversations appear here when they start"
        }
    }

    var retry: String {
        switch language {
        case .korean: return "다시 시도"
        case .english: return "Retry"
        }
    }

    var dismiss: String {
        switch language {
        case .korean: return "닫기"
        case .english: return "Dismiss"
        }
    }

    var messageLoadFailedTitle: String {
        switch language {
        case .korean: return "메시지를 불러오지 못했습니다"
        case .english: return "Messages could not be loaded"
        }
    }

    var messageLoadFailedDetail: String {
        switch language {
        case .korean: return "서버 연결을 확인하고 다시 시도하세요."
        case .english: return "Check the server connection and try again."
        }
    }

    var messageSendFailedTitle: String {
        switch language {
        case .korean: return "메시지를 보내지 못했습니다"
        case .english: return "Message was not sent"
        }
    }

    var messageSendFailedDetail: String {
        switch language {
        case .korean: return "내용은 보존되었습니다. 다시 보내기를 눌러 재시도하세요."
        case .english: return "Your message is preserved. Choose Send again to retry."
        }
    }

    func agentCallSendFailedTitle(_ agentName: String) -> String {
        switch language {
        case .korean: return "\(agentName) 호출을 보내지 못했습니다"
        case .english: return "The call to \(agentName) was not sent"
        }
    }

    var agentCallSendFailedDetail: String {
        switch language {
        case .korean: return "에이전트가 아직 호출되지 않았습니다. 다시 보내기를 눌러 재시도하세요."
        case .english: return "The agent has not been called yet. Choose Send again to retry."
        }
    }

    var sendAgain: String {
        switch language {
        case .korean: return "다시 보내기"
        case .english: return "Send again"
        }
    }

    var actionFailedTitle: String {
        switch language {
        case .korean: return "작업을 완료하지 못했습니다"
        case .english: return "The action could not be completed"
        }
    }

    var actionFailedDetail: String {
        switch language {
        case .korean: return "잠시 후 해당 작업을 다시 시도하세요."
        case .english: return "Try that action again in a moment."
        }
    }

    var sessionExpiredTitle: String {
        switch language {
        case .korean: return "로그인이 만료되었습니다"
        case .english: return "Your session expired"
        }
    }

    var sessionExpiredDetail: String {
        switch language {
        case .korean: return "계속하려면 다시 로그인하세요."
        case .english: return "Sign in again to continue."
        }
    }

    var signInAgain: String {
        switch language {
        case .korean: return "다시 로그인"
        case .english: return "Sign in again"
        }
    }

    var unreadSyncUnavailable: String {
        switch language {
        case .korean: return "읽지 않음 상태를 확인할 수 없음"
        case .english: return "Unread status unavailable"
        }
    }

    var unreadSyncUnavailableDetail: String {
        switch language {
        case .korean: return "표시된 배지가 최신이 아닐 수 있습니다."
        case .english: return "Shown badges may be out of date."
        }
    }

    var newChannel: String {
        switch language {
        case .korean: return "새 채널"
        case .english: return "New Channel"
        }
    }

    var createChannelTitle: String {
        switch language {
        case .korean: return "채널 만들기"
        case .english: return "Create a channel"
        }
    }

    var createChannelSubtitle: String {
        switch language {
        case .korean: return "대화를 정리할 공개 범위와 이름, 주제를 설정하세요."
        case .english: return "Choose who can join, then add a name and topic for the conversation."
        }
    }

    var channelVisibilityLabel: String {
        switch language {
        case .korean: return "공개 범위"
        case .english: return "Visibility"
        }
    }

    var channelNameLabel: String {
        switch language {
        case .korean: return "채널 이름"
        case .english: return "Channel name"
        }
    }

    var channelTopicLabel: String {
        switch language {
        case .korean: return "주제"
        case .english: return "Topic"
        }
    }

    var channelNameHelp: String {
        switch language {
        case .korean: return "영문, 숫자, 하이픈, 밑줄로 80자 이내로 입력하세요. 영문은 소문자로 저장됩니다."
        case .english: return "Use up to 80 letters, numbers, hyphens, or underscores. Letters are saved in lowercase."
        }
    }

    var channelTopicHelp: String {
        switch language {
        case .korean: return "선택 사항이며 280자까지 입력할 수 있습니다."
        case .english: return "Optional, up to 280 characters."
        }
    }

    var createChannelAction: String {
        switch language {
        case .korean: return "채널 만들기"
        case .english: return "Create channel"
        }
    }

    var creatingChannel: String {
        switch language {
        case .korean: return "채널 만드는 중"
        case .english: return "Creating channel"
        }
    }

    var retryChannelCreation: String {
        switch language {
        case .korean: return "채널 만들기 다시 시도"
        case .english: return "Try creating the channel again"
        }
    }

    func channelNameValidationMessage(_ error: MomoChannelNameValidationError) -> String {
        switch (language, error) {
        case (.korean, .required): return "채널 이름을 입력하세요."
        case (.english, .required): return "Enter a channel name."
        case (.korean, .tooLong): return "채널 이름은 80자 이내여야 합니다."
        case (.english, .tooLong): return "Keep the channel name to 80 characters or fewer."
        case (.korean, .unsupportedCharacters): return "영문, 숫자, 하이픈, 밑줄만 사용할 수 있습니다."
        case (.english, .unsupportedCharacters): return "Use only letters, numbers, hyphens, or underscores."
        }
    }

    func channelTopicValidationMessage(_ error: MomoChannelTopicValidationError) -> String {
        switch (language, error) {
        case (.korean, .tooLong): return "주제는 280자 이내여야 합니다."
        case (.english, .tooLong): return "Keep the topic to 280 characters or fewer."
        }
    }

    func channelCreateErrorMessage(_ issue: MomoChannelCreateIssue) -> String {
        switch (language, issue) {
        case (.korean, .invalidInput): return "입력 내용을 확인한 뒤 다시 시도하세요."
        case (.english, .invalidInput): return "Review the fields and try again."
        case (.korean, .duplicateName): return "같은 이름의 채널이 이미 있습니다. 다른 이름으로 다시 시도하세요."
        case (.english, .duplicateName): return "A channel with this name already exists. Try a different name."
        case (.korean, .permissionDenied): return "채널을 만들 권한이 없습니다. 워크스페이스 관리자에게 요청하세요."
        case (.english, .permissionDenied): return "You do not have permission to create channels. Ask a workspace admin."
        case (.korean, .connection): return "서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도하세요."
        case (.english, .connection): return "The server could not be reached. Check your connection and try again."
        case (.korean, .unavailable): return "채널을 만들지 못했습니다. 잠시 후 다시 시도하세요."
        case (.english, .unavailable): return "The channel could not be created. Try again in a moment."
        }
    }

    var cancel: String {
        switch language {
        case .korean: return "취소"
        case .english: return "Cancel"
        }
    }

    var create: String {
        switch language {
        case .korean: return "생성"
        case .english: return "Create"
        }
    }

    var publicChannel: String {
        switch language {
        case .korean: return "공개"
        case .english: return "Public"
        }
    }

    var privateChannel: String {
        switch language {
        case .korean: return "비공개"
        case .english: return "Private"
        }
    }

    var channelNamePlaceholder: String {
        switch language {
        case .korean: return "product-planning"
        case .english: return "product-planning"
        }
    }

    var channelTopicPlaceholder: String {
        switch language {
        case .korean: return "선택 사항"
        case .english: return "Optional"
        }
    }

    var commandCenter: String {
        switch language {
        case .korean: return "커맨드 센터"
        case .english: return "Command Center"
        }
    }

    var commandCenterInspectorSubtitle: String {
        switch language {
        case .korean: return "연결, 런타임, 테스트 상태를 필요할 때만 확인하는 진단 패널입니다."
        case .english: return "A diagnostic panel for connection, runtime, and test status when you need it."
        }
    }

    var approvalsInspectorSubtitle: String {
        switch language {
        case .korean: return "에이전트가 외부 작업 전 확인을 요청하면 여기에 모입니다."
        case .english: return "Agent actions that need human review collect here."
        }
    }

    var approveAllReversible: String {
        switch language {
        case .korean: return "되돌릴 수 있는 요청 모두 승인"
        case .english: return "Approve all reversible"
        }
    }

    var approve: String {
        switch language {
        case .korean: return "승인"
        case .english: return "Approve"
        }
    }

    var reject: String {
        switch language {
        case .korean: return "거부"
        case .english: return "Reject"
        }
    }

    var reversible: String {
        switch language {
        case .korean: return "되돌릴 수 있음"
        case .english: return "Reversible"
        }
    }

    var irreversible: String {
        switch language {
        case .korean: return "되돌리기 어려움"
        case .english: return "Irreversible"
        }
    }

    func approvalDelegationLabel(_ name: String) -> String {
        switch language {
        case .korean: return "\(name) 대신"
        case .english: return "as \(name)"
        }
    }

    func estimatedCost(_ cost: String) -> String {
        switch language {
        case .korean: return "예상 \(cost)"
        case .english: return "est. \(cost)"
        }
    }

    var detail: String {
        switch language {
        case .korean: return "상세"
        case .english: return "Detail"
        }
    }

    var updates: String {
        switch language {
        case .korean: return "업데이트"
        case .english: return "Updates"
        }
    }

    var downloads: String {
        switch language {
        case .korean: return "다운로드"
        case .english: return "Downloads"
        }
    }

    var downloadsSubtitle: String {
        switch language {
        case .korean: return "앱 업데이트 파일과 로컬 다운로드 위치를 확인합니다. 채팅 첨부파일 다운로드는 아직 지원하지 않습니다."
        case .english: return "Review app update files and local download locations. Chat attachment downloads are not supported yet."
        }
    }

    var downloadsScopeNote: String {
        switch language {
        case .korean: return "이 화면은 momo 앱 업데이트와 이 Mac의 다운로드 폴더만 다룹니다. 채팅 첨부파일은 다운로드하지 않습니다."
        case .english: return "This view covers momo app updates and this Mac's download folder only. It does not download chat attachments."
        }
    }

    var downloadHistory: String {
        switch language {
        case .korean: return "다운로드 이력"
        case .english: return "Download history"
        }
    }

    var downloadFolder: String {
        switch language {
        case .korean: return "다운로드 폴더"
        case .english: return "Download folder"
        }
    }

    var downloadFolderSubtitle: String {
        switch language {
        case .korean: return "다운로드가 저장될 기본 위치입니다."
        case .english: return "Default location for downloaded alpha builds."
        }
    }

    var changeDownloadFolder: String {
        switch language {
        case .korean: return "폴더 변경"
        case .english: return "Change folder"
        }
    }

    var openDownloadsFolder: String {
        switch language {
        case .korean: return "다운로드 폴더 열기"
        case .english: return "Open Downloads folder"
        }
    }

    var noDownloadHistory: String {
        switch language {
        case .korean: return "아직 다운로드 기록이 없습니다."
        case .english: return "No download history yet."
        }
    }

    var downloadReady: String {
        switch language {
        case .korean: return "다운로드 가능"
        case .english: return "Ready"
        }
    }

    var downloadUnavailable: String {
        switch language {
        case .korean: return "다운로드 없음"
        case .english: return "Unavailable"
        }
    }

    var downloadCheckSucceeded: String {
        switch language {
        case .korean: return "확인 성공"
        case .english: return "Check succeeded"
        }
    }

    var downloadCheckFailed: String {
        switch language {
        case .korean: return "확인 실패"
        case .english: return "Check failed"
        }
    }

    var updatesSubtitle: String {
        switch language {
        case .korean: return "현재 버전과 알파 업데이트 상태를 확인합니다."
        case .english: return "Review the current build and alpha update status."
        }
    }

    var currentVersion: String {
        switch language {
        case .korean: return "현재 버전"
        case .english: return "Current version"
        }
    }

    var availableVersion: String {
        switch language {
        case .korean: return "사용 가능 버전"
        case .english: return "Available version"
        }
    }

    var manifest: String {
        switch language {
        case .korean: return "매니페스트"
        case .english: return "Manifest"
        }
    }

    var latestVersion: String {
        switch language {
        case .korean: return "최신 버전입니다"
        case .english: return "Up to date"
        }
    }

    var updateAvailable: String {
        switch language {
        case .korean: return "업데이트 가능"
        case .english: return "Update available"
        }
    }

    var updatesNotConfigured: String {
        switch language {
        case .korean: return "업데이트 설정 필요"
        case .english: return "Updates not configured"
        }
    }

    var updateCheckFailed: String {
        switch language {
        case .korean: return "업데이트 확인 실패"
        case .english: return "Update check failed"
        }
    }

    var openDownload: String {
        switch language {
        case .korean: return "다운로드 열기"
        case .english: return "Open download"
        }
    }

    var releaseNotes: String {
        switch language {
        case .korean: return "릴리스 노트"
        case .english: return "Release notes"
        }
    }

    var noManifest: String {
        switch language {
        case .korean: return "매니페스트 없음"
        case .english: return "No manifest"
        }
    }

    var notConfigured: String {
        switch language {
        case .korean: return "설정되지 않음"
        case .english: return "Not configured"
        }
    }

    var notAvailable: String {
        switch language {
        case .korean: return "사용 불가"
        case .english: return "Not available"
        }
    }

    var updateStatusNotConfiguredDetail: String {
        switch language {
        case .korean: return "MOMO_UPDATE_MANIFEST_URL 또는 MOMO_UPDATE_MANIFEST_PATH를 설정하면 알파 업데이트 상태를 확인할 수 있습니다."
        case .english: return "Set MOMO_UPDATE_MANIFEST_URL or MOMO_UPDATE_MANIFEST_PATH to check alpha updates."
        }
    }

    var updateStatusUpToDateDetail: String {
        switch language {
        case .korean: return "현재 빌드가 알파 매니페스트의 최신 버전과 일치합니다."
        case .english: return "This build matches the latest version in the alpha manifest."
        }
    }

    var updateStatusAvailableDetail: String {
        switch language {
        case .korean: return "새 빌드를 다운로드한 뒤 앱을 다시 실행하면 됩니다."
        case .english: return "Download the newer build, replace the app, and relaunch."
        }
    }

    var updateStatusFailedDetail: String {
        switch language {
        case .korean: return "업데이트 매니페스트를 읽을 수 없습니다. 경로나 JSON 형식을 확인하세요."
        case .english: return "The update manifest could not be read. Check the path or JSON shape."
        }
    }

    func updateChannelLabel(_ channel: MomoMacUpdateChannel) -> String {
        switch (language, channel) {
        case (.korean, .alpha):
            return "알파 채널"
        case (.korean, .stable):
            return "안정 채널"
        case (.english, .alpha):
            return "Alpha channel"
        case (.english, .stable):
            return "Stable channel"
        }
    }

    var invites: String {
        switch language {
        case .korean: return "초대"
        case .english: return "Invites"
        }
    }

    var switchSession: String {
        switch language {
        case .korean: return "세션 전환"
        case .english: return "Switch"
        }
    }

    var logout: String {
        switch language {
        case .korean: return "로그아웃"
        case .english: return "Log Out"
        }
    }

    var showCommandCenter: String {
        switch language {
        case .korean: return "커맨드 센터 보기"
        case .english: return "Show Command Center"
        }
    }

    var showApprovals: String {
        switch language {
        case .korean: return "승인함 보기"
        case .english: return "Show approvals"
        }
    }

    var showDetailPane: String {
        switch language {
        case .korean: return "상세 패널 보기"
        case .english: return "Show detail pane"
        }
    }

    var hideDetailPane: String {
        switch language {
        case .korean: return "상세 패널 숨기기"
        case .english: return "Hide detail pane"
        }
    }

    var closeDetailPane: String {
        switch language {
        case .korean: return "상세 패널 닫기"
        case .english: return "Close detail pane"
        }
    }

    var live: String {
        switch language {
        case .korean: return "실시간 연결"
        case .english: return "Live"
        }
    }

    var restFallback: String {
        switch language {
        case .korean: return "최근 메시지 모드"
        case .english: return "Recent messages"
        }
    }

    var connectingLive: String {
        switch language {
        case .korean: return "실시간 연결 중"
        case .english: return "Connecting live"
        }
    }

    var reconnecting: String {
        switch language {
        case .korean: return "재연결 중"
        case .english: return "Reconnecting"
        }
    }

    var offlineRestFallback: String {
        switch language {
        case .korean: return "오프라인 · 최근 메시지"
        case .english: return "Offline · recent messages"
        }
    }

    var liveErrorRestFallback: String {
        switch language {
        case .korean: return "실시간 지연 · 최근 메시지"
        case .english: return "Live delayed · recent messages"
        }
    }

    var alphaCenterSubtitleReady: String {
        switch language {
        case .korean: return "현재 보이는 알파 기능을 사용할 수 있습니다."
        case .english: return "All visible alpha surfaces are usable."
        }
    }

    func alphaCenterSubtitle(attentionCount: Int) -> String {
        switch language {
        case .korean: return "\(attentionCount)개 항목에 확인이 필요합니다."
        case .english: return "\(attentionCount) surface(s) need attention."
        }
    }

    var status: String {
        switch language {
        case .korean: return "상태"
        case .english: return "Status"
        }
    }

    var presenceOnline: String {
        switch language {
        case .korean: return "온라인"
        case .english: return "Online"
        }
    }

    var presenceWorking: String {
        switch language {
        case .korean: return "작업 중"
        case .english: return "Working"
        }
    }

    var presenceAway: String {
        switch language {
        case .korean: return "자리 비움"
        case .english: return "Away"
        }
    }

    var presenceOffline: String {
        switch language {
        case .korean: return "오프라인"
        case .english: return "Offline"
        }
    }

    func presenceTitle(_ presence: Presence) -> String {
        switch presence {
        case .online:
            return presenceOnline
        case .working:
            return presenceWorking
        case .away:
            return presenceAway
        case .offline:
            return presenceOffline
        }
    }

    var today: String {
        switch language {
        case .korean: return "오늘 할 일"
        case .english: return "Today"
        }
    }

    var availableNotYet: String {
        switch language {
        case .korean: return "가능 / 준비 중"
        case .english: return "Available / Not Yet"
        }
    }

    var knownLimits: String {
        switch language {
        case .korean: return "알려진 제한"
        case .english: return "Known Limits"
        }
    }

    var agentCredentialSectionTitle: String {
        switch language {
        case .korean: return "에이전트 자격증명"
        case .english: return "Agent credentials"
        }
    }

    var agentCredentialSectionSubtitle: String {
        switch language {
        case .korean: return "momo와 Hermes gateway 사이에서만 사용하는 에이전트별 bearer입니다. Provider OAuth 자격증명과는 별개입니다."
        case .english: return "This per-agent bearer is only for momo and the Hermes gateway. It is separate from provider OAuth credentials."
        }
    }

    var agentCredentialLoading: String {
        switch language {
        case .korean: return "자격증명 상태를 불러오는 중"
        case .english: return "Loading credential status"
        }
    }

    var noAgentCredentials: String {
        switch language {
        case .korean: return "발급된 자격증명이 없습니다."
        case .english: return "No credential has been issued."
        }
    }

    var issueAgentCredential: String {
        switch language {
        case .korean: return "자격증명 발급"
        case .english: return "Issue credential"
        }
    }

    var rotateAgentCredential: String {
        switch language {
        case .korean: return "자격증명 회전"
        case .english: return "Rotate credential"
        }
    }

    var revokeAgentCredential: String {
        switch language {
        case .korean: return "자격증명 폐기"
        case .english: return "Revoke credential"
        }
    }

    var revokeAgentCredentialTitle: String {
        switch language {
        case .korean: return "이 자격증명을 폐기할까요?"
        case .english: return "Revoke this credential?"
        }
    }

    var revokeAgentCredentialConfirmation: String {
        switch language {
        case .korean: return "이 자격증명을 사용하는 gateway는 즉시 401을 받습니다. 새 자격증명을 발급하고 env 파일을 갱신해야 다시 연결할 수 있습니다."
        case .english: return "A gateway using this credential will immediately receive 401. Issue a new credential and update the env file to reconnect."
        }
    }

    var agentCredentialActions: String {
        switch language {
        case .korean: return "자격증명 동작"
        case .english: return "Credential actions"
        }
    }

    var agentCredentialRotationHint: String {
        switch language {
        case .korean: return "회전하면 기존 자격증명은 기본 24시간 유예 동안 함께 동작합니다. 새 값을 env 파일에 반영하고 gateway를 다시 시작하세요."
        case .english: return "Rotation keeps the previous credential working for a 24-hour grace period. Update the env file and restart the gateway."
        }
    }

    var agentCredential401Recovery: String {
        switch language {
        case .korean: return "Gateway가 401을 받으면 여기서 새 자격증명을 발급하고 ~/.momo/hermes-gateway.env의 MOMO_AGENT_TOKEN을 교체하세요."
        case .english: return "If the gateway receives 401, issue a new credential here and replace MOMO_AGENT_TOKEN in ~/.momo/hermes-gateway.env."
        }
    }

    var agentCredentialRevokedRecovery: String {
        switch language {
        case .korean: return "자격증명을 폐기했습니다. Gateway가 401을 받으면 새 값을 발급해 env 파일을 갱신하세요."
        case .english: return "Credential revoked. If the gateway receives 401, issue a new value and update the env file."
        }
    }

    var agentCredentialDefaultLabel: String {
        switch language {
        case .korean: return "Hermes gateway"
        case .english: return "Hermes gateway"
        }
    }

    var agentCredentialNeverUsed: String {
        switch language {
        case .korean: return "아직 사용되지 않음"
        case .english: return "Not used yet"
        }
    }

    func agentCredentialCreated(_ milliseconds: Int64) -> String {
        switch language {
        case .korean: return "발급 \(agentCredentialDate(milliseconds))"
        case .english: return "Issued \(agentCredentialDate(milliseconds))"
        }
    }

    func agentCredentialLastUsed(_ milliseconds: Int64) -> String {
        switch language {
        case .korean: return "최근 사용 \(agentCredentialDate(milliseconds))"
        case .english: return "Last used \(agentCredentialDate(milliseconds))"
        }
    }

    func agentCredentialExpires(_ milliseconds: Int64) -> String {
        switch language {
        case .korean: return "만료 \(agentCredentialDate(milliseconds))"
        case .english: return "Expires \(agentCredentialDate(milliseconds))"
        }
    }

    func agentCredentialStatus(_ status: MomoAgentCredentialDisplayStatus) -> String {
        switch (language, status) {
        case (.korean, .configured): return "설정됨"
        case (.english, .configured): return "Configured"
        case (.korean, .active): return "사용 중"
        case (.english, .active): return "Active"
        case (.korean, .expiring): return "만료 임박"
        case (.english, .expiring): return "Expiring"
        case (.korean, .revoked): return "폐기됨"
        case (.english, .revoked): return "Revoked"
        }
    }

    func agentCredentialStatusAccessibility(_ status: MomoAgentCredentialDisplayStatus) -> String {
        switch language {
        case .korean: return "자격증명 상태: \(agentCredentialStatus(status))"
        case .english: return "Credential status: \(agentCredentialStatus(status))"
        }
    }

    var agentCredentialOneTimeTitle: String {
        switch language {
        case .korean: return "새 자격증명을 지금 저장하세요"
        case .english: return "Save the new credential now"
        }
    }

    var agentCredentialOneTimeSubtitle: String {
        switch language {
        case .korean: return "이 bearer 원문은 이 화면에서 한 번만 표시되며 다시 조회할 수 없습니다."
        case .english: return "The raw bearer is shown once on this screen and cannot be retrieved again."
        }
    }

    var agentCredentialTokenLabel: String {
        switch language {
        case .korean: return "일회 표시 bearer"
        case .english: return "One-time bearer"
        }
    }

    var agentCredentialTokenAccessibility: String {
        switch language {
        case .korean: return "한 번만 표시되는 에이전트 bearer 값"
        case .english: return "One-time agent bearer value"
        }
    }

    var copyAgentCredentialToken: String {
        switch language {
        case .korean: return "토큰 복사"
        case .english: return "Copy token"
        }
    }

    var copyAgentCredentialEnvironmentLine: String {
        switch language {
        case .korean: return "env 줄 복사"
        case .english: return "Copy env line"
        }
    }

    var agentCredentialTokenCopied: String {
        switch language {
        case .korean: return "토큰을 클립보드에 복사했습니다."
        case .english: return "Token copied to the clipboard."
        }
    }

    var agentCredentialEnvironmentLineCopied: String {
        switch language {
        case .korean: return "MOMO_AGENT_TOKEN env 줄을 클립보드에 복사했습니다."
        case .english: return "MOMO_AGENT_TOKEN env line copied to the clipboard."
        }
    }

    var agentCredentialEnvironmentTitle: String {
        switch language {
        case .korean: return "Hermes gateway env에 반영"
        case .english: return "Update the Hermes gateway env"
        }
    }

    var agentCredentialEnvironmentInstructions: String {
        switch language {
        case .korean: return "복사한 MOMO_AGENT_TOKEN 줄을 이 파일에 넣고 파일 권한이 600인지 확인한 뒤 gateway를 다시 시작하세요. momo 앱은 이 파일을 직접 쓰지 않습니다."
        case .english: return "Add the copied MOMO_AGENT_TOKEN line to this file, verify that its mode is 600, then restart the gateway. The momo app does not write this file."
        }
    }

    func agentCredentialGraceMessage(_ milliseconds: Int64) -> String {
        switch language {
        case .korean: return "기존 자격증명은 \(agentCredentialDate(milliseconds))까지 유효합니다. 그 전에 gateway를 새 값으로 다시 시작하세요."
        case .english: return "The previous credential remains valid until \(agentCredentialDate(milliseconds)). Restart the gateway with the new value before then."
        }
    }

    var agentCredentialRevealSecurityNote: String {
        switch language {
        case .korean: return "이 창을 닫으면 원문은 메모리에서 제거됩니다. 매니페스트와 export에는 bearer가 포함되지 않습니다."
        case .english: return "Closing this window removes the raw value from transient state. Pairing manifests and exports never include the bearer."
        }
    }

    func agentCredentialErrorMessage(_ error: Error) -> String {
        if case BackendError.notConnected = error {
            switch language {
            case .korean: return "오프라인 상태입니다. 서버 연결을 복구한 뒤 자격증명 상태를 새로고침하세요."
            case .english: return "You are offline. Restore the server connection, then refresh credential status."
            }
        }
        if case BackendError.realtime(_) = error {
            switch language {
            case .korean: return "서버에 연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도하세요."
            case .english: return "The server is unreachable. Check the network, then try again."
            }
        }
        if case BackendError.problem(let status, _, _) = error {
            if status == 401 {
                switch language {
                case .korean: return "관리자 세션이 만료되었습니다. 다시 로그인한 뒤 자격증명 상태를 새로고침하세요."
                case .english: return "The admin session expired. Sign in again, then refresh credential status."
                }
            }
            if status == 403 {
                switch language {
                case .korean: return "워크스페이스 관리자만 에이전트 자격증명을 관리할 수 있습니다."
                case .english: return "Only workspace admins can manage agent credentials."
                }
            }
        }
        switch language {
        case .korean: return "자격증명 요청을 완료하지 못했습니다. 서버 연결을 확인하고 다시 시도하세요."
        case .english: return "The credential request could not be completed. Check the server connection and try again."
        }
    }

    func channelUnreadAccessibilityLabel(
        channelName: String,
        unreadCount: Int64,
        mentionCount: Int
    ) -> String {
        guard unreadCount > 0 || mentionCount > 0 else { return channelName }
        switch language {
        case .korean:
            return "\(channelName), 읽지 않은 메시지 \(unreadCount)개, 멘션 \(mentionCount)개"
        case .english:
            return "\(channelName), \(unreadCount) unread messages, \(mentionCount) mentions"
        }
    }

    func timelineDay(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: language == .korean ? "ko_KR" : "en_US")
        formatter.setLocalizedDateFormatFromTemplate("MMMMdEEEE")
        return formatter.string(from: date)
    }

    private func agentCredentialDate(_ milliseconds: Int64) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: language == .korean ? "ko_KR" : "en_US")
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000))
    }
}
