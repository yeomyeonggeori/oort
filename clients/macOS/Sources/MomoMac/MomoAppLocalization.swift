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
        case .korean: return "로컬 Hermes gateway를 실행한 뒤, 이 워크스페이스에 표시할 별칭과 프로필을 확정합니다."
        case .english: return "Run the local Hermes gateway, then confirm the alias and profile shown in this workspace."
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

    var providerEndpoint: String {
        switch language {
        case .korean: return "연결 endpoint"
        case .english: return "Provider endpoint"
        }
    }

    var agentInviteNetworkNote: String {
        switch language {
        case .korean: return "momo는 provider OAuth/token을 저장하지 않습니다. 토큰은 Hermes/provider 런타임 안에만 둡니다."
        case .english: return "momo does not store provider OAuth tokens. Credentials stay inside the Hermes/provider runtime."
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
        case .korean: return "언어, 화면 모드, 워크스페이스 표시를 관리합니다."
        case .english: return "Manage language, appearance, and workspace display."
        }
    }

    var general: String {
        switch language {
        case .korean: return "일반"
        case .english: return "General"
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
        case .korean: return "워크스페이스 표시"
        case .english: return "Workspace display"
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

    var serverIconImage: String {
        switch language {
        case .korean: return "서버 아이콘"
        case .english: return "Server icon"
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

    var commandCenterInspectorSubtitle: String {
        switch language {
        case .korean: return "테스트와 진단은 필요할 때만 여는 보조 패널입니다."
        case .english: return "Open test and diagnostic controls only when you need them."
        }
    }

    var approvalsInspectorSubtitle: String {
        switch language {
        case .korean: return "에이전트가 외부 작업 전 확인을 요청하면 여기에 모입니다."
        case .english: return "Agent actions that need human review collect here."
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
        case .korean: return "알파 빌드 다운로드와 로컬 다운로드 위치를 확인합니다."
        case .english: return "Review alpha build downloads and local download locations."
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
