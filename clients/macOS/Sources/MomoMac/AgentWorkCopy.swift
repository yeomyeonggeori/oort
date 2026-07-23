import Foundation
import MomoCore

extension MomoWorkspaceCopy {
    /// Sidebar/badge label when more than one agent works a channel at once.
    func agentsWorkingCount(_ count: Int) -> String {
        switch language {
        case .korean: return "에이전트 \(count)명 작업 중"
        case .english: return count == 1 ? "1 agent working" : "\(count) agents working"
        }
    }

    /// Accessibility readout for the elapsed working clock (digits from the caller).
    func agentWorkingElapsed(_ formatted: String) -> String {
        switch language {
        case .korean: return "작업 시간 \(formatted)"
        case .english: return "Working for \(formatted)"
        }
    }

    var stopAgentRun: String {
        language == .korean ? "실행 중지" : "Stop run"
    }

    var stoppingAgentRun: String {
        language == .korean ? "실행 중지 중" : "Stopping run"
    }

    var stopAgentRunShortcut: String {
        language == .korean ? "실행 중지 (⌘.)" : "Stop run (⌘.)"
    }

    func stopAgentRunError(_ issue: MomoAgentSafetyIssue) -> String {
        switch (language, issue) {
        case (.korean, .permissionDenied):
            return "이 실행을 중지할 권한이 없습니다. 채널 멤버십을 확인하세요."
        case (.korean, .notFound):
            return "실행을 찾을 수 없습니다. Work 기록을 새로고침하세요."
        case (.korean, .conflict):
            return "이미 완료된 실행은 중지할 수 없습니다. Work 상태를 새로고침하세요."
        case (.korean, .unavailable):
            return "실행 중지 응답을 확인하지 못했습니다. 다시 시도하세요."
        case (.korean, .connection):
            return "실행을 중지하지 못했습니다. 연결을 확인하고 다시 시도하세요."
        case (.english, .permissionDenied):
            return "You cannot stop this run. Check your channel membership."
        case (.english, .notFound):
            return "The run could not be found. Refresh Work history."
        case (.english, .conflict):
            return "A completed run cannot be stopped. Refresh its Work status."
        case (.english, .unavailable):
            return "The stop response could not be verified. Try again."
        case (.english, .connection):
            return "The run could not be stopped. Check the connection and try again."
        }
    }

    /// The canceller is the system line's author on the server ledger; name
    /// them when known so a multi-person channel keeps its accountability.
    func agentRunCancelledSystemLine(actorName: String?) -> String {
        let trimmed = actorName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            return language == .korean ? "사람이 이 실행을 중지했습니다." : "A person stopped this run."
        }
        return language == .korean
            ? "\(trimmed)님이 이 실행을 중지했습니다."
            : "\(trimmed) stopped this run."
    }

    var agentPausedSystemLine: String {
        language == .korean
            ? "이 에이전트는 일시정지되어 새 실행을 시작하지 않았습니다."
            : "This agent is paused, so a new run did not start."
    }

    var pauseAgent: String {
        language == .korean ? "에이전트 일시정지" : "Pause agent"
    }

    var agentPausedState: String {
        language == .korean ? "일시정지됨" : "Paused"
    }

    var agentActiveState: String {
        language == .korean ? "활성" : "Active"
    }

    var agentPauseLoading: String {
        language == .korean ? "일시정지 상태 불러오는 중" : "Loading pause status"
    }

    var agentPauseOffline: String {
        language == .korean
            ? "서버에 연결한 뒤 일시정지 상태를 변경하세요."
            : "Connect to the server before changing pause status."
    }

    var agentPauseUnavailable: String {
        language == .korean
            ? "일시정지 상태를 불러오지 못했습니다. 다시 불러오세요."
            : "Pause status could not load. Try loading it again."
    }

    func agentPauseError(_ issue: MomoAgentSafetyIssue) -> String {
        switch (language, issue) {
        case (.korean, .permissionDenied):
            return "일시정지 상태를 변경할 권한이 없습니다. 에이전트 관리 권한을 확인하세요."
        case (.korean, .notFound):
            return "에이전트 프로필을 찾을 수 없습니다. 멤버 목록을 새로고침하세요."
        case (.korean, .conflict):
            return "일시정지 상태가 변경되었습니다. 현재 상태를 다시 불러오세요."
        case (.korean, .unavailable):
            return "일시정지 응답을 확인하지 못했습니다. 현재 상태를 다시 불러오세요."
        case (.korean, .connection):
            return agentPauseOffline
        case (.english, .permissionDenied):
            return "You cannot change pause status. Check your agent management permission."
        case (.english, .notFound):
            return "The agent profile could not be found. Refresh the member list."
        case (.english, .conflict):
            return "Pause status changed. Load the current status again."
        case (.english, .unavailable):
            return "The pause response could not be verified. Load the current status again."
        case (.english, .connection):
            return agentPauseOffline
        }
    }

    var retryAgentPause: String {
        language == .korean ? "일시정지 상태 다시 불러오기" : "Retry pause status"
    }

    var agentPauseExplanation: String {
        language == .korean
            ? "일시정지하면 새 멘션과 Work 실행을 받지 않습니다. 진행 중인 실행은 별도로 중지하세요."
            : "A paused agent ignores new mentions and Work runs. Stop existing runs separately."
    }

    var startWork: String {
        switch language {
        case .korean: return "Work 시작"
        case .english: return "Start Work"
        }
    }

    var workCommandHint: String {
        switch language {
        case .korean: return "/work로 에이전트에게 업무를 맡기세요"
        case .english: return "Use /work to assign a task to an agent"
        }
    }

    var workComposerTitle: String {
        switch language {
        case .korean: return "새 Work"
        case .english: return "New Work"
        }
    }

    var workComposerSubtitle: String {
        switch language {
        case .korean: return "이 채널에 초대된 에이전트가 실행하고, 과정과 결과는 타임라인에 남습니다."
        case .english: return "An invited channel agent runs the task. Progress and results stay in the timeline."
        }
    }

    var workAgentLabel: String {
        switch language {
        case .korean: return "담당 에이전트"
        case .english: return "Agent"
        }
    }

    var workTitleLabel: String {
        switch language {
        case .korean: return "제목"
        case .english: return "Title"
        }
    }

    var workTitlePlaceholder: String {
        switch language {
        case .korean: return "예: macOS 테스트 실패 수정"
        case .english: return "Example: Fix the macOS test failure"
        }
    }

    var workBriefLabel: String {
        switch language {
        case .korean: return "업무 설명"
        case .english: return "Brief"
        }
    }

    var workBriefPlaceholder: String {
        switch language {
        case .korean: return "완료 조건과 지켜야 할 범위를 적어주세요."
        case .english: return "Describe the outcome and boundaries."
        }
    }

    var cancelWorkComposer: String {
        switch language {
        case .korean: return "Work 작성 취소"
        case .english: return "Cancel Work"
        }
    }

    var noWorkAgentsTitle: String {
        switch language {
        case .korean: return "선택할 에이전트가 없습니다"
        case .english: return "No agent is available"
        }
    }

    var noWorkAgentsBody: String {
        switch language {
        case .korean: return "활성 에이전트를 이 채널에 초대한 뒤 다시 시작하세요."
        case .english: return "Invite an active agent to this channel, then start Work again."
        }
    }

    var returnToMessage: String {
        switch language {
        case .korean: return "메시지로 돌아가기"
        case .english: return "Return to message"
        }
    }

    var workUnavailableTitle: String {
        switch language {
        case .korean: return "이 서버에서는 Work를 시작할 수 없습니다"
        case .english: return "Work is unavailable on this server"
        }
    }

    var workUnavailableBody: String {
        switch language {
        case .korean: return "Work를 지원하는 서버에 연결한 뒤 다시 시도하세요."
        case .english: return "Connect to a server that supports Work, then try again."
        }
    }

    var workRestFallbackNote: String {
        switch language {
        case .korean: return "실시간 연결이 없어도 Work 시작 요청은 REST로 전송됩니다."
        case .english: return "Work can still start over REST while realtime is unavailable."
        }
    }

    var workLiveLog: String {
        switch language {
        case .korean: return "실행 로그"
        case .english: return "Live log"
        }
    }

    var workHistoryLoading: String {
        switch language {
        case .korean: return "Work 기록 불러오는 중"
        case .english: return "Loading Work history"
        }
    }

    var workDetailsLoading: String {
        switch language {
        case .korean: return "Work 상세 불러오는 중"
        case .english: return "Loading Work details"
        }
    }

    var workApprovalPendingSync: String {
        switch language {
        case .korean: return "승인 요청 내용을 불러오는 중입니다."
        case .english: return "Loading the approval request."
        }
    }

    var retryWorkHistory: String {
        switch language {
        case .korean: return "Work 기록 다시 불러오기"
        case .english: return "Retry Work history"
        }
    }

    var expandWorkLog: String {
        switch language {
        case .korean: return "로그 펼치기"
        case .english: return "Expand log"
        }
    }

    var collapseWorkLog: String {
        switch language {
        case .korean: return "로그 접기"
        case .english: return "Collapse log"
        }
    }

    var openWorkDetails: String {
        switch language {
        case .korean: return "Work 상세 열기"
        case .english: return "Open Work details"
        }
    }

    var workDetailTitle: String {
        switch language {
        case .korean: return "Work 상세"
        case .english: return "Work details"
        }
    }

    var workDetailSubtitle: String {
        switch language {
        case .korean: return "전체 transcript와 승인, 실행 결과를 확인합니다."
        case .english: return "Review the full transcript, approval, and result."
        }
    }

    var workTranscript: String {
        switch language {
        case .korean: return "전체 transcript"
        case .english: return "Full transcript"
        }
    }

    var workTranscriptEmpty: String {
        switch language {
        case .korean: return "아직 기록된 실행 로그가 없습니다."
        case .english: return "No execution log has been recorded yet."
        }
    }

    var workResult: String {
        switch language {
        case .korean: return "실행 결과"
        case .english: return "Result"
        }
    }

    var workAgent: String {
        switch language {
        case .korean: return "담당"
        case .english: return "Assigned to"
        }
    }

    var workRepository: String {
        switch language {
        case .korean: return "저장소"
        case .english: return "Repository"
        }
    }

    var workBranch: String {
        switch language {
        case .korean: return "브랜치"
        case .english: return "Branch"
        }
    }

    var workCreatedAt: String {
        switch language {
        case .korean: return "시작 요청"
        case .english: return "Requested"
        }
    }

    var workCompletedWithoutSummary: String {
        switch language {
        case .korean: return "Work가 완료되었습니다. 전체 기록에서 실행 내용을 확인하세요."
        case .english: return "Work completed. Review the full transcript for execution details."
        }
    }

    var workFailedWithoutSummary: String {
        switch language {
        case .korean: return "Work가 완료되지 않았습니다. 오류 기록을 확인한 뒤 다시 요청하세요."
        case .english: return "Work did not complete. Review the error log before trying again."
        }
    }

    var workCancelledWithoutSummary: String {
        switch language {
        case .korean: return "Work가 취소되었습니다. 남아 있는 실행 기록을 확인하세요."
        case .english: return "Work was cancelled. Review any execution details that were recorded."
        }
    }

    var workDiffSummary: String {
        switch language {
        case .korean: return "변경 요약"
        case .english: return "Diff summary"
        }
    }

    var workExitCode: String {
        switch language {
        case .korean: return "종료 코드"
        case .english: return "Exit code"
        }
    }

    var workPullRequest: String {
        switch language {
        case .korean: return "PR 열기"
        case .english: return "Open pull request"
        }
    }

    var workApprovalTitle: String {
        switch language {
        case .korean: return "실행 전 승인이 필요합니다"
        case .english: return "Approval is required before execution"
        }
    }

    var workApprovalRecording: String {
        switch language {
        case .korean: return "결정 기록 중"
        case .english: return "Recording decision"
        }
    }

    func workApprovalSummary(agentName: String, action: String?) -> String {
        let trimmed = action?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: ".!?。！？")) ?? ""
        switch language {
        case .korean:
            return trimmed.isEmpty
                ? "\(MomoKoreanParticle.attach(.subject, to: agentName)) 작업 승인을 요청했습니다."
                : "\(MomoKoreanParticle.attach(.subject, to: agentName)) ‘\(trimmed)’ 작업의 승인을 요청했습니다."
        case .english:
            return trimmed.isEmpty
                ? "\(agentName) requested approval for a task."
                : "\(agentName) requested approval for ‘\(trimmed)’."
        }
    }

    var refreshWorkDetails: String {
        switch language {
        case .korean: return "Work 상세 새로고침"
        case .english: return "Refresh Work details"
        }
    }

    var dismissWorkError: String {
        switch language {
        case .korean: return "Work 오류 닫기"
        case .english: return "Dismiss Work error"
        }
    }

    func workChangedFiles(_ count: Int) -> String {
        switch language {
        case .korean: return "변경 파일 \(count)개"
        case .english: return count == 1 ? "1 changed file" : "\(count) changed files"
        }
    }

    func workError(_ error: AgentWorkSurfaceError) -> String {
        switch (language, error) {
        case (.korean, .channelRequired):
            return "Work를 시작할 채널을 먼저 선택하세요."
        case (.korean, .unsupportedServer):
            return "이 서버에서는 Work를 시작할 수 없습니다. Work를 지원하는 서버에 연결하세요."
        case (.korean, .activeAgentRequired):
            return "이 채널에 초대된 활성 에이전트를 선택하세요."
        case (.korean, .titleRequired):
            return "Work 제목을 입력하세요."
        case (.korean, .briefRequired):
            return "에이전트가 수행할 업무를 설명하세요."
        case (.korean, .creationFailed):
            return "Work를 시작하지 못했습니다. 요청을 확인하고 다시 시도하세요."
        case (.korean, .historyFailed):
            return "Work 기록을 불러오지 못했습니다. 다시 불러오세요."
        case (.korean, .detailFailed):
            return "Work 상세를 불러오지 못했습니다. 다시 새로고침하세요."
        case (.english, .channelRequired):
            return "Select a channel before starting Work."
        case (.english, .unsupportedServer):
            return "Work is unavailable on this server. Connect to a server that supports Work."
        case (.english, .activeAgentRequired):
            return "Choose an active agent already invited to this channel."
        case (.english, .titleRequired):
            return "Add a title before starting Work."
        case (.english, .briefRequired):
            return "Describe the work for the agent."
        case (.english, .creationFailed):
            return "Work could not start. Review the request and try again."
        case (.english, .historyFailed):
            return "Work history could not load. Try loading it again."
        case (.english, .detailFailed):
            return "Work details could not load. Refresh the details and try again."
        }
    }

    func workStatus(_ status: RunStatus) -> String {
        switch (language, status) {
        case (.korean, .queued): return "대기"
        case (.korean, .running): return "실행 중"
        case (.korean, .awaitingApproval): return "승인 대기"
        case (.korean, .paused): return "입력 대기"
        case (.korean, .succeeded): return "완료"
        case (.korean, .failed): return "실패"
        case (.korean, .cancelled): return "취소"
        case (.korean, .timedOut): return "시간 초과"
        case (.english, .queued): return "Queued"
        case (.english, .running): return "Running"
        case (.english, .awaitingApproval): return "Awaiting approval"
        case (.english, .paused): return "Input required"
        case (.english, .succeeded): return "Completed"
        case (.english, .failed): return "Failed"
        case (.english, .cancelled): return "Cancelled"
        case (.english, .timedOut): return "Timed out"
        }
    }

    func approvalDecision(_ status: ApprovalStatus) -> String {
        switch (language, status) {
        case (.korean, .pending): return "승인 대기"
        case (.korean, .approved): return "승인됨"
        case (.korean, .rejected): return "거절됨"
        case (.korean, .expired): return "만료됨"
        case (.korean, .cancelled): return "취소됨"
        case (.english, .pending): return "Pending"
        case (.english, .approved): return "Approved"
        case (.english, .rejected): return "Rejected"
        case (.english, .expired): return "Expired"
        case (.english, .cancelled): return "Cancelled"
        }
    }
}
