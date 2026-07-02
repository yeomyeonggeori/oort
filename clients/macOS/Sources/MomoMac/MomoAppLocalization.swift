import SwiftUI

public extension MomoUILanguage {
    static let appStorageKey = "momo.ui.language"
}

struct MomoWorkspaceCopy {
    var language: MomoUILanguage

    var languageLabel: String {
        switch language {
        case .korean: return "언어"
        case .english: return "Language"
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

    var noPendingApprovals: String {
        switch language {
        case .korean: return "대기 중인 승인 없음"
        case .english: return "No pending approvals"
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

    var agentInviteTitle: String {
        switch language {
        case .korean: return "로컬 에이전트 초대"
        case .english: return "Invite a local agent"
        }
    }

    var agentInviteBody: String {
        switch language {
        case .korean: return "에르메스 같은 로컬 에이전트를 설치하고 provider를 설정한 뒤, 별칭과 초대코드로 momo에 연결하는 흐름입니다."
        case .english: return "Install a local agent such as Hermes, configure a provider, then connect it to momo with an alias and invite code."
        }
    }

    var agentAlias: String {
        switch language {
        case .korean: return "호출 별칭 예: @hermes"
        case .english: return "Call alias, e.g. @hermes"
        }
    }

    var providerEndpoint: String {
        switch language {
        case .korean: return "Provider endpoint"
        case .english: return "Provider endpoint"
        }
    }

    var agentInviteNetworkNote: String {
        switch language {
        case .korean: return "다음 단계에서 초대코드와 네트워크 핸드셰이크로 에이전트 통신 채널을 엽니다."
        case .english: return "Next, an invite-code network handshake will open the agent communication channel."
        }
    }

    var prepareAgentInvite: String {
        switch language {
        case .korean: return "에이전트 연결 준비"
        case .english: return "Prepare agent connection"
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

    var serverSettings: String {
        switch language {
        case .korean: return "서버 설정"
        case .english: return "Server settings"
        }
    }

    var serverSettingsSubtitle: String {
        switch language {
        case .korean: return "이름, 아이콘, 초대 권한 초안을 관리합니다."
        case .english: return "Manage the name, icon, and invite policy draft."
        }
    }

    var serverName: String {
        switch language {
        case .korean: return "서버명"
        case .english: return "Server name"
        }
    }

    var serverIconText: String {
        switch language {
        case .korean: return "아이콘 문자"
        case .english: return "Icon text"
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
        case .korean: return "현재 dogfood 앱에서는 표시/정책 초안으로 저장됩니다. 서버 영속 설정 API는 후속 goal에서 연결합니다."
        case .english: return "For this dogfood app, these are saved as local display/policy drafts. Server persistence follows in a later goal."
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
        case .korean: return "사용 가능한 채널이 없습니다"
        case .english: return "No channels available"
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

    var recoverableError: String {
        switch language {
        case .korean: return "복구 가능한 오류"
        case .english: return "Recoverable error"
        }
    }

    var newChannel: String {
        switch language {
        case .korean: return "새 채널"
        case .english: return "New Channel"
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
        case .korean: return "채널 이름"
        case .english: return "name"
        }
    }

    var channelTopicPlaceholder: String {
        switch language {
        case .korean: return "주제"
        case .english: return "topic"
        }
    }

    var commandCenter: String {
        switch language {
        case .korean: return "커맨드 센터"
        case .english: return "Command Center"
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

    var live: String {
        switch language {
        case .korean: return "실시간 연결"
        case .english: return "Live"
        }
    }

    var restFallback: String {
        switch language {
        case .korean: return "REST 폴백"
        case .english: return "REST fallback"
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
        case .korean: return "오프라인 - REST 폴백"
        case .english: return "Offline - REST fallback"
        }
    }

    var liveErrorRestFallback: String {
        switch language {
        case .korean: return "실시간 오류 - REST 폴백"
        case .english: return "Live error - REST fallback"
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
}
