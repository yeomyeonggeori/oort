import Foundation
import MomoCore

extension MomoWorkspaceCopy {
    var workConsole: String { language == .korean ? "Work Console" : "Work Console" }
    var workConsoleSubtitle: String {
        language == .korean ? "로컬과 원격 작업 세션" : "Local and remote work sessions"
    }
    var openWorkConsole: String { language == .korean ? "Work Console 열기" : "Open Work Console" }
    var closeWorkConsole: String { language == .korean ? "Work Console 닫기" : "Close Work Console" }
    var resizeWorkConsoleDrawer: String {
        language == .korean ? "Work Console 높이 조절" : "Resize Work Console height"
    }
    var resetWorkConsoleDrawerSize: String {
        language == .korean ? "Work Console 높이 초기화" : "Reset Work Console height"
    }
    func workConsoleHeightValue(_ height: CGFloat) -> String {
        language == .korean ? "높이 \(Int(height))포인트" : "\(Int(height)) points high"
    }
    var resizeWorkSessionList: String {
        language == .korean ? "세션 목록 너비 조절" : "Resize session list"
    }
    var resetWorkSessionListSize: String {
        language == .korean ? "세션 목록 너비 초기화" : "Reset session list width"
    }
    func workSessionListWidthValue(_ width: CGFloat) -> String {
        language == .korean ? "너비 \(Int(width))포인트" : "\(Int(width)) points wide"
    }
    var resizeRightDetailPanel: String {
        language == .korean ? "우측 패널 너비 조절" : "Resize right panel"
    }
    var resetRightDetailPanelSize: String {
        language == .korean ? "우측 패널 너비 초기화" : "Reset right panel width"
    }
    func rightDetailPanelWidthValue(_ width: CGFloat) -> String {
        language == .korean ? "너비 \(Int(width))포인트" : "\(Int(width)) points wide"
    }
    var newWorkSession: String { language == .korean ? "새 세션" : "New session" }
    var newTerminal: String { language == .korean ? "새 터미널" : "New terminal" }
    var workSessions: String { language == .korean ? "세션" : "Sessions" }
    var workSessionLoading: String { language == .korean ? "세션 불러오는 중" : "Loading sessions" }
    var workSessionEmptyTitle: String { language == .korean ? "아직 세션이 없습니다" : "No sessions yet" }
    var workSessionEmptyBody: String {
        language == .korean
            ? "새 세션을 시작하면 채널에 카드가 생기고 같은 스레드에서 협업할 수 있습니다."
            : "Start a session to create a channel card and collaborate in its thread."
    }
    var workSessionDetachedTitle: String {
        language == .korean ? "이 터미널은 현재 앱에 연결되어 있지 않습니다" : "This terminal is not attached to the current app"
    }
    var workSessionDetachedBody: String {
        language == .korean
            ? "다른 호스트에서 시작했거나 앱을 다시 연 세션입니다. 스레드 기록은 계속 볼 수 있습니다."
            : "It was started on another host or before the app reopened. The thread history remains available."
    }
    var workSessionRunning: String { language == .korean ? "실행 중" : "Running" }
    var workSessionOrphaned: String { language == .korean ? "호스트 연결 끊김" : "Host disconnected" }
    var workSessionEnded: String { language == .korean ? "종료됨" : "Ended" }
    func workSessionStatus(_ status: MomoWorkSessionStatus) -> String {
        switch status {
        case .running: workSessionRunning
        case .orphaned: workSessionOrphaned
        case .ended: workSessionEnded
        }
    }
    var workResumeOfferTitle: String {
        language == .korean ? "다른 호스트에서 재개" : "Resume on another host"
    }
    var workResumeOfferBody: String {
        language == .korean
            ? "이 세션의 호스트 연결이 끊겼습니다. 마지막으로 push한 커밋부터 새 세션을 시작할 수 있습니다."
            : "This session lost its host. You can start a new session from the last pushed commit."
    }
    var workResumeLossWarning: String {
        language == .korean
            ? "미커밋 변경과 실행 중인 프로세스는 이전되지 않습니다."
            : "Uncommitted changes and running processes are not transferred."
    }
    var workResumeChooseHost: String { language == .korean ? "재개할 호스트" : "Resume host" }
    var workResumeNoHost: String {
        language == .korean ? "온라인 상태인 다른 호스트가 없습니다." : "No other online host is available."
    }
    var workResumeAction: String { language == .korean ? "새 세션으로 재개" : "Resume as new session" }
    var workResumeInFlight: String { language == .korean ? "재개 요청 중" : "Resuming" }
    var workResumeOpenConsole: String { language == .korean ? "Work에서 재개" : "Resume in Work" }
    var workSessionLineage: String { language == .korean ? "이전 세션에서 이어짐" : "Continued from session" }
    func workSessionShortID(_ id: WorkSessionID) -> String {
        String(id.description.lowercased().prefix(8))
    }
    func workSessionExit(_ code: Int) -> String {
        language == .korean ? "종료 코드 \(code)" : "Exit \(code)"
    }
    var workSessionOpenThread: String { language == .korean ? "세션 스레드 열기" : "Open session thread" }
    var workSessionEnd: String { language == .korean ? "세션 종료" : "End session" }
    func workSessionShortcut(_ number: Int) -> String {
        language == .korean ? "세션 \(number) 열기" : "Open session \(number)"
    }
    var workSessionFocusTerminal: String { language == .korean ? "터미널에 포커스" : "Focus terminal" }
    var workSessionShareExcerpt: String { language == .korean ? "발췌 공유" : "Share excerpt" }
    var workSessionOpenRemoteTerminal: String { language == .korean ? "터미널 열기" : "Open terminal" }
    var workSessionObserveTerminal: String { language == .korean ? "터미널 관전" : "Watch terminal" }
    func workSessionObservers(_ count: Int64) -> String {
        language == .korean ? "관전 \(count)" : "\(count) watching"
    }
    var workSessionObservationMenu: String {
        language == .korean ? "터미널 관전 범위" : "Terminal observation access"
    }
    var workSessionObservationOpen: String {
        language == .korean ? "팀원 관전 허용" : "Allow team observation"
    }
    var workSessionObservationOwnerOnly: String {
        language == .korean ? "소유자만 보기" : "Owner only"
    }
    var workSessionObserverTitle: String {
        language == .korean ? "읽기 전용 관전 중" : "Watching read-only"
    }
    var workSessionObserverBody: String {
        language == .korean
            ? "출력만 이 Mac으로 직접 전송됩니다. 입력, 크기 조절, 종료는 사용할 수 없습니다."
            : "Only output is sent directly to this Mac. Input, resize, and terminate controls are unavailable."
    }
    var workSessionRemoteRetry: String { language == .korean ? "다시 연결" : "Reconnect" }
    var workSessionRemoteGrantLoading: String {
        language == .korean ? "원격 터미널 연결 권한을 받는 중" : "Requesting remote terminal access"
    }
    var workSessionRemoteConnecting: String {
        language == .korean ? "원격 터미널에 연결하는 중" : "Connecting to the remote terminal"
    }
    var workSessionRemoteDisconnected: String {
        language == .korean ? "원격 터미널 연결이 끊겼습니다. 다시 연결하세요." : "The remote terminal disconnected. Reconnect to continue."
    }
    var workSessionRemoteEnded: String {
        language == .korean ? "세션이 종료되어 터미널을 읽기 전용으로 표시합니다." : "The session ended. The terminal is now read-only."
    }

    func remoteTerminalError(_ error: MomoRemoteTerminalError) -> String {
        switch (error, language) {
        case (.grantExpired, .korean): "연결 권한이 만료됐습니다. 새 권한으로 다시 연결하세요."
        case (.grantExpired, .english): "Terminal access expired. Reconnect with a new grant."
        case (.forbidden, .korean): "이 세션의 터미널을 열 권한이 없습니다. 세션 소유자를 확인하세요."
        case (.forbidden, .english): "You cannot open this terminal. Check the session owner."
        case (.revokedOrUnavailable, .korean): "세션이 종료됐거나 원격 호스트 연결이 해제됐습니다. 상태를 확인한 뒤 다시 연결하세요."
        case (.revokedOrUnavailable, .english): "The session ended or the remote host was revoked. Check its status, then reconnect."
        case (.rateLimited, .korean): "연결 요청이 너무 많습니다. 잠시 후 다시 연결하세요."
        case (.rateLimited, .english): "There were too many connection attempts. Reconnect in a moment."
        case (.networkDisconnected, .korean): "네트워크 연결이 끊겼습니다. 연결 상태를 확인한 뒤 다시 연결하세요."
        case (.networkDisconnected, .english): "The network connection was lost. Check your connection, then reconnect."
        case (.invalidGrant, .korean), (.invalidFrame, .korean): "원격 터미널 응답을 확인하지 못했습니다. 다시 연결하세요."
        case (.invalidGrant, .english), (.invalidFrame, .english): "The remote terminal response was invalid. Reconnect to try again."
        }
    }
    var workSessionLocalOnly: String {
        language == .korean
            ? "전체 출력과 입력은 이 Mac에만 남습니다. 공유를 누른 발췌만 스레드에 전송됩니다."
            : "Full output and input stay on this Mac. Only excerpts you share are sent to the thread."
    }
    var workSessionProfile: String { language == .korean ? "도구" : "Tool" }
    var workSessionLabel: String { language == .korean ? "표시 이름" : "Display name" }
    var workSessionLabelPlaceholder: String {
        language == .korean ? "예: 결제 모듈 점검" : "Example: Review payment module"
    }
    var workSessionFolder: String { language == .korean ? "작업 폴더" : "Working folder" }
    var workSessionDefaultFolder: String { language == .korean ? "기본 폴더" : "Default folder" }
    var workSessionChooseFolder: String { language == .korean ? "폴더 선택" : "Choose folder" }
    var workSessionFolderPrivacy: String {
        language == .korean
            ? "서버에는 표시 이름만 저장되며 실제 경로는 전송되지 않습니다."
            : "Only the display name is stored on the server. The actual path is never sent."
    }
    var startWorkSession: String { language == .korean ? "세션 시작" : "Start session" }
    var workToolProfiles: String { language == .korean ? "도구 프로파일" : "Tool profiles" }
    var workToolProfilesHelp: String {
        language == .korean
            ? "등록된 도구만 새 세션과 원격 실행에 표시됩니다. 실행 경로와 자격증명은 서버에 저장하지 않습니다."
            : "Only registered tools appear for new sessions and remote runs. Executable paths and credentials never reach the server."
    }
    var workToolProfileAdd: String { language == .korean ? "도구 등록" : "Register tool" }
    var workToolProfileEdit: String { language == .korean ? "프로파일 편집" : "Edit profile" }
    var workToolProfileDelete: String { language == .korean ? "도구 등록 해제" : "Unregister tool" }
    var workToolProfileDeleteTitle: String { language == .korean ? "이 도구를 등록 해제할까요?" : "Unregister this tool?" }
    var workToolProfileDeleteBody: String {
        language == .korean
            ? "새 실행에서 즉시 숨겨지고 자동 승인 설정도 함께 지워집니다. 기존 세션 기록은 유지됩니다."
            : "It is hidden from new runs immediately and its auto-approval setting is cleared. Existing session history remains."
    }
    var workToolProfileUnavailable: String {
        language == .korean ? "활성화된 도구 프로파일이 없습니다." : "No enabled tool profiles are available."
    }
    var workToolKey: String { language == .korean ? "도구 키" : "Tool key" }
    var workToolDisplayName: String { language == .korean ? "표시 이름" : "Display name" }
    var workToolCommand: String { language == .korean ? "명령 키" : "Command key" }
    var workToolArguments: String { language == .korean ? "인자 (한 줄에 하나)" : "Arguments (one per line)" }
    var workToolTransport: String { language == .korean ? "연결 방식" : "Transport" }
    var workToolPermissionPolicy: String { language == .korean ? "도구 사용 정책" : "Tool-use policy" }
    var workToolRisk: String { language == .korean ? "위험도" : "Risk" }
    var workToolPTY: String { language == .korean ? "터미널" : "Terminal" }
    var workToolACP: String { language == .korean ? "ACP 세션" : "ACP session" }
    var workToolEnabled: String { language == .korean ? "새 실행에 표시" : "Show for new runs" }
    func workToolPermissionPolicy(_ policy: MomoWorkToolPermissionPolicy) -> String {
        switch (policy, language) {
        case (.confirm, .korean): "매번 확인"
        case (.confirm, .english): "Confirm each time"
        case (.allow, .korean): "허용"
        case (.allow, .english): "Allow"
        case (.deny, .korean): "거부"
        case (.deny, .english): "Deny"
        }
    }
    func workToolRisk(_ risk: MomoWorkToolRisk) -> String {
        switch (risk, language) {
        case (.low, .korean): "낮음"
        case (.low, .english): "Low"
        case (.medium, .korean): "보통"
        case (.medium, .english): "Medium"
        case (.high, .korean): "높음"
        case (.high, .english): "High"
        }
    }
    var workToolSave: String { language == .korean ? "프로파일 저장" : "Save profile" }
    var workToolSaving: String { language == .korean ? "저장 중" : "Saving" }
    var workToolInvalid: String {
        language == .korean
            ? "키와 명령은 영문 소문자·숫자·점·대시만 사용할 수 있으며, 인자에 경로와 자격증명을 넣을 수 없습니다."
            : "Keys and commands use lowercase letters, numbers, dots, or dashes. Arguments cannot contain paths or credentials."
    }
    var acpInitialPrompt: String { language == .korean ? "첫 요청" : "Initial prompt" }
    var acpInitialPromptPlaceholder: String {
        language == .korean ? "에이전트에게 맡길 작업을 입력하세요" : "Describe the task for the agent"
    }
    var acpCardTitle: String { language == .korean ? "ACP 작업" : "ACP work" }
    var acpPlan: String { language == .korean ? "계획" : "Plan" }
    var acpProgress: String { language == .korean ? "진행" : "Progress" }
    var acpPermission: String { language == .korean ? "승인 필요" : "Permission required" }
    var acpPermissionResolved: String { language == .korean ? "처리됨" : "Resolved" }
    var acpWaiting: String { language == .korean ? "에이전트 응답을 기다리는 중" : "Waiting for agent update" }
    func acpPermissionOption(kind: String, fallback: String) -> String {
        switch (kind, language) {
        case ("allow_once", .korean): "이번만 허용"
        case ("allow_once", .english): "Allow once"
        case ("allow_always", .korean): "항상 허용"
        case ("allow_always", .english): "Always allow"
        case ("reject_once", .korean): "이번만 거부"
        case ("reject_once", .english): "Reject once"
        case ("reject_always", .korean): "항상 거부"
        case ("reject_always", .english): "Always reject"
        default: fallback
        }
    }
    func acpPermissionResult(status: String, optionID: String?) -> String {
        if status == "approved" {
            return language == .korean ? "도구 사용을 허용했습니다." : "Tool use was allowed."
        }
        return language == .korean ? "도구 사용을 거부했습니다." : "Tool use was rejected."
    }
    func acpPlanStatus(_ status: String) -> String {
        switch (status, language) {
        case ("completed", .korean): "완료"
        case ("completed", .english): "Completed"
        case ("in_progress", .korean): "진행 중"
        case ("in_progress", .english): "In progress"
        case (_, .korean): "대기"
        case (_, .english): "Pending"
        }
    }
    func acpToolStatus(_ status: String) -> String {
        switch (status, language) {
        case ("pending", .korean): "대기"
        case ("pending", .english): "Pending"
        case ("in_progress", .korean), ("running", .korean): "진행 중"
        case ("in_progress", .english), ("running", .english): "In progress"
        case ("completed", .korean): "완료"
        case ("completed", .english): "Completed"
        case ("failed", .korean): "실패"
        case ("failed", .english): "Failed"
        default: status
        }
    }
    var workConsoleSettings: String { language == .korean ? "Work 설정" : "Work settings" }
    var workTierPolicyTitle: String { language == .korean ? "호스트 상실 시 재개" : "Host-loss recovery" }
    var workTierPolicyPersonal: String { language == .korean ? "내 정책" : "My policy" }
    var workTierPolicyWorkspace: String { language == .korean ? "워크스페이스 기본" : "Workspace default" }
    var workTierPolicyInherited: String {
        language == .korean ? "워크스페이스 기본값을 상속 중" : "Using the workspace default"
    }
    var workTierPolicyT1Only: String { language == .korean ? "이 Mac에서만" : "This Mac only" }
    var workTierPolicyAsk: String { language == .korean ? "연결 끊김 시 묻기" : "Ask when disconnected" }
    var workTierPolicyAuto: String { language == .korean ? "자동 재개" : "Resume automatically" }
    var workTierPolicyCloud: String { language == .korean ? "momo Cloud" : "momo Cloud" }
    var workTierPolicyUpdating: String { language == .korean ? "정책 저장 중" : "Saving policy" }
    var workTierPolicyFailed: String {
        language == .korean ? "정책을 불러오지 못했습니다. 기존 세션은 그대로 유지됩니다." : "Could not load the policy. Existing sessions are unchanged."
    }
    var workTierPolicyHelp: String {
        language == .korean
            ? "자동 재개는 선택한 호스트에서 마지막 push 커밋으로 새 세션을 시작합니다. 비용이 생길 수 있어 직접 켜야 합니다."
            : "Automatic recovery starts a new session from the last pushed commit on the selected host. It is opt-in because it may incur cost."
    }
    func workTierPolicyTitle(_ mode: MomoWorkTierPolicyMode) -> String {
        switch mode {
        case .t1Only: workTierPolicyT1Only
        case .ask: workTierPolicyAsk
        case .auto: workTierPolicyAuto
        }
    }
    var terminalTheme: String { language == .korean ? "터미널 테마" : "Terminal theme" }
    var terminalThemeHelp: String {
        language == .korean
            ? "앱 화면 모드와 별도로 모든 로컬 터미널에 적용됩니다."
            : "Applies to every local terminal independently of the app appearance."
    }
    func terminalThemeTitle(_ preset: MomoTerminalThemePreset) -> String {
        switch (preset, language) {
        case (.dark, .korean): "다크, 기본"
        case (.dark, .english): "Dark, default"
        case (.light, .korean): "라이트"
        case (.light, .english): "Light"
        case (.highContrast, .korean): "고대비"
        case (.highContrast, .english): "High contrast"
        case (.colorBlindSafe, .korean): "색약 친화"
        case (.colorBlindSafe, .english): "Color vision friendly"
        }
    }
    var workHostIdentifier: String { language == .korean ? "이 Mac의 호스트 ID" : "Host ID for this Mac" }
    var copyWorkHostIdentifier: String { language == .korean ? "호스트 ID 복사" : "Copy host ID" }
    var workHostPreparing: String { language == .korean ? "이 Mac을 Work 호스트로 등록하는 중" : "Registering this Mac as a Work host" }
    var workHostRegistered: String { language == .korean ? "등록됨, 연결 확인 중" : "Registered, checking connection" }
    var workHostOnline: String { language == .korean ? "온라인" : "Online" }
    var workHostOffline: String {
        language == .korean
            ? "호스트 연결 상태를 확인하지 못했습니다. 등록 상태를 다시 확인합니다."
            : "Host presence could not be confirmed. Registration will be checked again."
    }
    var workHostRetry: String { language == .korean ? "호스트 등록 다시 시도" : "Retry host registration" }
    var workHostAgentWorkerHelp: String {
        language == .korean
            ? "AgentWorker의 MOMO_WORK_HOST_ID를 이 값으로 설정하면 에이전트 요청이 이 Mac으로 연결됩니다."
            : "Set AgentWorker MOMO_WORK_HOST_ID to this value to route agent requests to this Mac."
    }
    var workHostPrivateKeyHelp: String {
        language == .korean
            ? "서명용 개인키는 이 Mac에만 저장되며 서버로 전송되지 않습니다."
            : "The signing private key stays on this Mac and is never sent to the server."
    }
    var workAutoApprove: String { language == .korean ? "도구별 자동 승인" : "Auto-approve by tool" }
    var workAutoApproveUnknown: String {
        language == .korean
            ? "서버에 조회 API가 없어 현재 값은 변경 후에만 표시됩니다."
            : "The server has no read API, so a value appears only after you change it."
    }
    var workAutoApproveEnable: String { language == .korean ? "자동 승인 켜기" : "Enable auto-approve" }
    var workAutoApproveDisable: String { language == .korean ? "매번 승인받기" : "Require approval" }
    var workAutoApproveEnabled: String { language == .korean ? "자동 승인" : "Auto-approved" }
    var workAutoApproveDisabled: String { language == .korean ? "승인 필요" : "Approval required" }
    var workAutoApproveUpdating: String { language == .korean ? "변경 중" : "Updating" }
    var workAutoApproveFailed: String { language == .korean ? "변경 실패" : "Update failed" }
    var workReadRequestTitle: String { language == .korean ? "에이전트가 출력 발췌를 요청했습니다" : "An agent requested an output excerpt" }
    func workReadRequestBody(lines: Int) -> String {
        language == .korean
            ? "최근 \(lines)줄을 검토한 뒤 공유할 수 있습니다. 자동 전송하지 않습니다."
            : "Review the last \(lines) lines before sharing. Nothing is sent automatically."
    }
    var workReadReview: String { language == .korean ? "검토 후 공유" : "Review and share" }
    var workReadDecline: String { language == .korean ? "공유 안 함" : "Do not share" }
    var workExcerptTitle: String { language == .korean ? "세션 발췌 공유" : "Share session excerpt" }
    var workExcerptWarning: String {
        language == .korean
            ? "토큰, 비밀번호, 개인 경로가 없는지 확인하세요. 공유하면 채널 스레드 원장에 저장됩니다."
            : "Check for tokens, passwords, and personal paths. Shared text is stored in the channel thread ledger."
    }
    var workExcerptSend: String { language == .korean ? "스레드에 공유" : "Share to thread" }
    var workConsoleRefresh: String { language == .korean ? "세션 새로고침" : "Refresh sessions" }
    var workConsoleSandboxTitle: String {
        language == .korean ? "이 빌드에서는 로컬 CLI가 제한됩니다" : "Local CLI is restricted in this build"
    }
    var workConsoleSandboxBody: String {
        language == .korean
            ? "배포용 앱의 App Sandbox 정책을 별도로 승인해 전환해야 터미널 세션을 시작할 수 있습니다."
            : "The packaged app needs an approved App Sandbox policy change before it can start terminal sessions."
    }

    func workToolTitle(_ tool: MomoWorkTool) -> String {
        if tool == .claude { return "Claude" }
        if tool == .codex { return "Codex" }
        if tool == .opencode { return "OpenCode" }
        if tool == .shell { return language == .korean ? "셸" : "Shell" }
        return tool.rawValue
    }

    func workToolSubtitle(_ tool: MomoWorkTool) -> String {
        if tool == .claude { return language == .korean ? "Claude Code 로컬 세션" : "Local Claude Code session" }
        if tool == .codex { return language == .korean ? "Codex CLI 로컬 세션" : "Local Codex CLI session" }
        if tool == .opencode { return language == .korean ? "OpenCode 로컬 세션" : "Local OpenCode session" }
        if tool == .shell { return language == .korean ? "로그인 셸 세션" : "Login shell session" }
        return language == .korean ? "등록된 로컬 도구" : "Registered local tool"
    }
}

extension MomoWorkTool {
    var systemImage: String {
        if self == .claude { return "c.circle" }
        if self == .codex { return "terminal" }
        if self == .opencode { return "chevron.left.forwardslash.chevron.right" }
        if self == .shell { return "apple.terminal" }
        return "wrench.and.screwdriver"
    }
}
