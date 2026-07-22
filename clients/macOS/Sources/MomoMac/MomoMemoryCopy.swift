import Foundation
import MomoCore

extension MomoWorkspaceCopy {
    var memoryBrowserTitle: String { language == .korean ? "에이전트가 아는 것" : "What agents know" }
    var memoryBrowserSubtitle: String {
        language == .korean
            ? "워크스페이스 메모리와 에이전트에게 실제로 제공된 컨텍스트를 확인합니다."
            : "Review workspace memory and the context actually served to agents."
    }
    var memorySearchPlaceholder: String { language == .korean ? "메모리 검색" : "Search memory" }
    var memoryScopeFilterTitle: String { language == .korean ? "범위" : "Scope" }
    var memoryAgentFilterTitle: String { language == .korean ? "에이전트" : "Agent" }
    var memoryAllScopes: String { language == .korean ? "모든 범위" : "All scopes" }
    var memoryAllAgents: String { language == .korean ? "모든 에이전트" : "All agents" }
    var memoryShowInactive: String { language == .korean ? "무효화된 항목 포함" : "Include invalidated" }
    var memoryNoResults: String { language == .korean ? "표시할 메모리가 없습니다." : "No memory to show." }
    var memoryNoResultsDetail: String {
        language == .korean ? "필터를 바꾸거나 검색어를 지워보세요." : "Change the filters or clear the search."
    }
    var memorySelectionPrompt: String { language == .korean ? "메모리를 선택하세요." : "Select a memory." }
    var memoryUnavailable: String { language == .korean ? "메모리 서비스를 사용할 수 없습니다." : "Memory service is unavailable." }
    var memoryRetry: String { language == .korean ? "다시 불러오기" : "Reload" }
    var memoryActive: String { language == .korean ? "활성" : "Active" }
    var memoryInvalidated: String { language == .korean ? "무효화됨" : "Invalidated" }
    var memoryBody: String { language == .korean ? "내용" : "Content" }
    var memoryConfidence: String { language == .korean ? "신뢰도" : "Confidence" }
    var memorySources: String { language == .korean ? "출처 메시지" : "Source messages" }
    var memoryOpenSource: String { language == .korean ? "대화에서 보기" : "Show in conversation" }
    var memorySourceUnavailable: String {
        language == .korean
            ? "이 출처 메시지는 현재 불러온 대화나 검색 결과에 없습니다. 서버의 메시지 단건 조회 계약이 준비되면 바로 이동할 수 있습니다."
            : "This source is not in loaded history or search results. Direct navigation requires a server message lookup contract."
    }
    var memorySave: String { language == .korean ? "변경 저장" : "Save changes" }
    var memoryInvalidate: String { language == .korean ? "메모리 무효화" : "Invalidate memory" }
    var memoryInvalidateConfirmation: String {
        language == .korean
            ? "이 항목은 삭제되지 않고 감사 가능한 무효 상태로 남습니다."
            : "This item is not deleted. It remains as auditable invalid history."
    }
    var memoryPolicyTitle: String { language == .korean ? "워크스페이스 메모리" : "Workspace memory" }
    var memoryPolicyToggle: String {
        language == .korean ? "워크스페이스 메모리 사용" : "Use workspace memory"
    }
    var memoryPolicyDetail: String {
        language == .korean
            ? "끄면 서버가 메모리 투영을 삭제합니다. 이 작업은 되돌릴 수 없습니다."
            : "Turning this off purges server memory projections and cannot be undone."
    }
    var memoryDisableTitle: String { language == .korean ? "워크스페이스 메모리를 끌까요?" : "Turn off workspace memory?" }
    var memoryDisableAction: String { language == .korean ? "끄고 삭제" : "Turn off and purge" }
    var memoryGrantTitle: String { language == .korean ? "메모리 접근 허용" : "Memory access" }
    var memoryGrantAdd: String { language == .korean ? "접근 허용" : "Allow access" }
    var memoryGrantConfirm: String { language == .korean ? "접근 허용" : "Allow access" }
    var memoryGrantLoading: String { language == .korean ? "접근 내역을 불러오는 중" : "Loading access history" }
    var memoryGrantEmpty: String {
        language == .korean ? "추가로 접근이 허용된 멤버나 에이전트가 없습니다." : "No additional members or agents have access."
    }
    var memoryGrantOffline: String {
        language == .korean
            ? "연결이 끊겨 메모리 접근 내역을 불러오지 못했습니다. 연결 후 다시 시도해 주세요."
            : "Memory access history is unavailable while offline. Reconnect and try again."
    }
    var memoryGrantRetry: String { language == .korean ? "접근 내역 다시 불러오기" : "Reload access history" }
    var memoryGrantReadOnly: String {
        language == .korean ? "이 메모리의 접근 내역을 읽기 전용으로 보고 있습니다." : "You have read-only access to this memory's access history."
    }
    var memoryGrantActions: String { language == .korean ? "메모리 접근 작업" : "Memory access actions" }
    var memoryGrantPickerTitle: String { language == .korean ? "메모리 접근 허용" : "Allow memory access" }
    var memoryGrantPickerDetail: String {
        language == .korean
            ? "이 메모리를 볼 수 있는 워크스페이스 멤버나 에이전트를 선택하세요."
            : "Choose a workspace member or agent who can view this memory."
    }
    var memoryGrantSearchPlaceholder: String { language == .korean ? "멤버 또는 에이전트 검색" : "Search members or agents" }
    var memoryGrantNoCandidates: String { language == .korean ? "선택할 대상이 없습니다." : "No one is available to select." }
    var memoryGrantNoCandidatesDetail: String {
        language == .korean
            ? "활성 명부의 모든 대상에게 이미 접근이 허용되었는지 확인해 주세요."
            : "Everyone in the active roster may already have access."
    }
    var memoryGrantUnknownMember: String { language == .korean ? "알 수 없는 멤버" : "Unknown member" }
    var memoryGrantRevoked: String { language == .korean ? "회수됨" : "Access revoked" }
    var memoryRevokeTitle: String { language == .korean ? "메모리 접근을 회수할까요?" : "Revoke memory access?" }
    var memoryRevokeAction: String { language == .korean ? "접근 회수" : "Revoke access" }
    func memoryRevokeConfirmation(name: String) -> String {
        language == .korean
            ? "\(name) 님은 더 이상 이 메모리를 볼 수 없습니다. 접근 내역은 기록으로 남습니다."
            : "\(name) will no longer be able to view this memory. The access history remains recorded."
    }
    func memoryGrantBadge(_ kind: MomoMemoryGrantGranteeKind) -> String {
        switch (language, kind) {
        case (.korean, .member): return "멤버"
        case (.korean, .agent): return "에이전트"
        case (.english, .member): return "Member"
        case (.english, .agent): return "Agent"
        }
    }
    func memoryGrantedBy(_ name: String, date: String) -> String {
        language == .korean ? "\(name) 님이 \(date)에 허용" : "Allowed by \(name) on \(date)"
    }
    func memoryRevokedAt(_ date: String) -> String {
        language == .korean ? "\(date)에 접근 회수" : "Access revoked on \(date)"
    }
    var memoryGrantGenericError: String {
        language == .korean ? "메모리 접근 설정을 변경하지 못했습니다. 다시 시도해 주세요." : "Memory access could not be changed. Try again."
    }
    var memoryGrantInvalidTargetError: String {
        language == .korean
            ? "선택한 대상을 확인할 수 없습니다. 명부를 새로 불러온 뒤 다시 시도해 주세요."
            : "The selected person could not be found. Reload the roster and try again."
    }
    var memoryGrantAuthenticationError: String {
        language == .korean
            ? "로그인이 만료되어 메모리 접근 설정을 변경하지 못했습니다. 다시 로그인해 주세요."
            : "Your session expired. Sign in again to change memory access."
    }
    var memoryGrantPermissionError: String {
        language == .korean ? "이 메모리의 접근 설정을 변경할 권한이 없습니다." : "You do not have permission to change access to this memory."
    }
    var memoryGrantNotFoundError: String {
        language == .korean
            ? "메모리 또는 접근 내역을 찾을 수 없습니다. 목록을 다시 불러와 주세요."
            : "The memory or access history could not be found. Reload the list."
    }
    var memoryGrantRateLimitError: String {
        language == .korean
            ? "요청이 너무 많아 변경하지 못했습니다. 잠시 후 다시 시도해 주세요."
            : "There are too many requests. Wait a moment and try again."
    }
    var memoryGrantServerError: String {
        language == .korean
            ? "서버가 메모리 접근 설정을 변경하지 못했습니다. 다시 시도해 주세요."
            : "The server could not change memory access. Try again."
    }
    var memoryGrantInvalidResponseError: String {
        language == .korean
            ? "메모리 접근 내역을 읽지 못했습니다. 다시 불러와 주세요."
            : "Memory access history could not be read. Reload it."
    }
    var servedContextTitle: String { language == .korean ? "서빙 내역" : "Served context" }
    var servedContextAction: String { language == .korean ? "서빙 내역 보기" : "View served context" }
    func memoryDeliverySummary(_ count: Int) -> String {
        language == .korean ? "메모리 \(count)건 반영" : "\(count) memory items included"
    }
    var servedContextSubtitle: String {
        language == .korean
            ? "이 실행에 서빙된 저장 스냅샷입니다. 현재 정책으로 다시 구성하지 않습니다."
            : "The stored snapshot served to this run. It is not rebuilt from current policy."
    }
    var servedContextExpired: String { language == .korean ? "만료된 스냅샷" : "Expired snapshot" }
    var servedContextCurrent: String { language == .korean ? "발급 당시 스냅샷" : "Issued snapshot" }
    var servedContextHistory: String { language == .korean ? "대화 범위" : "Conversation history" }
    var servedContextMemories: String { language == .korean ? "포함된 메모리" : "Included memory" }
    var servedContextTools: String { language == .korean ? "허용된 도구" : "Tool grants" }
    var servedContextBudget: String { language == .korean ? "사용 한도" : "Budget" }
    var servedContextRedactions: String { language == .korean ? "제외된 정보" : "Redactions" }
    var servedContextEmpty: String { language == .korean ? "포함된 항목 없음" : "No items included" }
    var servedContextUnavailable: String {
        language == .korean
            ? "이 실행에 서빙된 저장 스냅샷을 찾을 수 없습니다."
            : "No stored snapshot served to this run is available."
    }
    var servedContextLoading: String { language == .korean ? "서빙 내역 불러오는 중" : "Loading served context" }
    var servedContextYes: String { language == .korean ? "예" : "Yes" }
    var servedContextNo: String { language == .korean ? "아니요" : "No" }
    var servedContextUnknownValue: String { language == .korean ? "값 없음" : "Not available" }
    var servedContextBudgetIdentifier: String { language == .korean ? "한도 ID" : "Budget ID" }
    var servedContextModelRoute: String { language == .korean ? "모델 경로" : "Model route" }
    var servedContextMaxPromptTokens: String { language == .korean ? "최대 입력" : "Maximum prompt" }
    var servedContextMaxCompletionTokens: String { language == .korean ? "최대 출력" : "Maximum completion" }
    var servedContextReservedCost: String { language == .korean ? "예약 금액" : "Reserved cost" }
    var servedContextSoftLimit: String { language == .korean ? "알림 한도" : "Soft limit" }
    var servedContextHardLimit: String { language == .korean ? "최대 한도" : "Hard limit" }
    var servedContextApprovalThreshold: String { language == .korean ? "승인 기준 금액" : "Approval threshold" }
    var servedContextUsageLedgerMode: String { language == .korean ? "사용량 기록 방식" : "Usage ledger mode" }
    var servedContextOtherBudget: String { language == .korean ? "기타 한도" : "Other budget" }
    var servedContextTokenUnit: String { language == .korean ? "토큰" : "tokens" }
    var memoryCreatedAt: String { language == .korean ? "생성" : "Created" }
    var memoryUpdatedAt: String { language == .korean ? "최근 변경" : "Updated" }

    func memoryScopeTitle(_ scope: MemoryScope) -> String {
        switch (language, scope) {
        case (.korean, .workspace): return "워크스페이스"
        case (.korean, .member): return "멤버"
        case (.korean, .agent): return "에이전트"
        case (.korean, .conversation): return "대화"
        case (.english, .workspace): return "Workspace"
        case (.english, .member): return "Member"
        case (.english, .agent): return "Agent"
        case (.english, .conversation): return "Conversation"
        }
    }

    func memoryKindTitle(_ kind: MemoryKind) -> String {
        switch (language, kind) {
        case (.korean, .profile): return "프로필"
        case (.korean, .fact): return "사실"
        case (.korean, .episode): return "에피소드"
        case (.korean, .procedure): return "절차"
        case (.english, .profile): return "Profile"
        case (.english, .fact): return "Fact"
        case (.english, .episode): return "Episode"
        case (.english, .procedure): return "Procedure"
        }
    }

    func servedContextMessageSequence(_ sequence: Int64) -> String {
        language == .korean ? "메시지 \(sequence)번째" : "Message \(sequence)"
    }

    func memorySourceLabel(channelName: String?, date: String) -> String {
        guard let channelName else { return date }
        return "#\(channelName) · \(date)"
    }

    func servedContextBudgetLabel(_ key: String) -> String {
        switch key {
        case "budget_id": return servedContextBudgetIdentifier
        case "model_route": return servedContextModelRoute
        case "max_prompt_tokens": return servedContextMaxPromptTokens
        case "max_completion_tokens": return servedContextMaxCompletionTokens
        case "reserved_micro_usd": return servedContextReservedCost
        case "soft_limit_micro_usd": return servedContextSoftLimit
        case "hard_limit_micro_usd": return servedContextHardLimit
        case "approval_required_over_micro_usd": return servedContextApprovalThreshold
        case "usage_ledger_mode": return servedContextUsageLedgerMode
        default: return servedContextOtherBudget
        }
    }
}
