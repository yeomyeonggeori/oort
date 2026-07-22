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
    var memoryAllScopes: String { language == .korean ? "모든 범위" : "All scopes" }
    var memoryAllAgents: String { language == .korean ? "모든 에이전트" : "All agents" }
    var memoryShowInactive: String { language == .korean ? "무효화된 항목 포함" : "Include invalidated" }
    var memoryNoResults: String { language == .korean ? "표시할 메모리가 없습니다." : "No memory to show." }
    var memoryNoResultsDetail: String {
        language == .korean ? "필터를 바꾸거나 검색어를 지워보세요." : "Change the filters or clear the search."
    }
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
    var memoryPolicyDetail: String {
        language == .korean
            ? "끄면 서버가 메모리 투영을 삭제합니다. 이 작업은 되돌릴 수 없습니다."
            : "Turning this off purges server memory projections and cannot be undone."
    }
    var memoryDisableTitle: String { language == .korean ? "워크스페이스 메모리를 끌까요?" : "Turn off workspace memory?" }
    var memoryDisableAction: String { language == .korean ? "끄고 삭제" : "Turn off and purge" }
    var memoryGrantTitle: String { language == .korean ? "공유 권한" : "Visibility grants" }
    var memoryGrantUnavailable: String {
        language == .korean
            ? "서버의 공유 권한 목록·회수 계약이 준비될 때까지 변경 기능을 잠급니다."
            : "Grant changes remain locked until the server exposes list and revoke contracts."
    }
    var servedContextTitle: String { language == .korean ? "서빙 내역" : "Served context" }
    var servedContextSubtitle: String {
        language == .korean
            ? "이 실행에 저장된 불변 Context Packet입니다. 현재 정책으로 다시 조립하지 않습니다."
            : "The immutable Context Packet stored for this run. It is never rebuilt from current policy."
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
            ? "이 실행에서 저장 packet 식별자를 찾을 수 없습니다."
            : "No stored packet identifier is available for this run."
    }
    var servedContextLoading: String { language == .korean ? "서빙 내역 불러오는 중" : "Loading served context" }
    var servedContextYes: String { language == .korean ? "예" : "Yes" }
    var servedContextNo: String { language == .korean ? "아니요" : "No" }
    var servedContextUnknownValue: String { language == .korean ? "값 없음" : "Not available" }
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
}
