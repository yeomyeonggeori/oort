# 외부 리서치 ④ — 5개 표면 UXUI 레퍼런스 분석: 동종 오픈소스 실태와 momo 구현 제안 (2026-07-21, Fable · PLN-20260721-01)

> 발단: 성재 지시 ② — "피드백을 단계별로 어떤 형태·어떤 UXUI로 구현할지 동종 오픈소스 레퍼런스 분석으로". 대상 표면: (A) 산출물 diff 카드(MOMO-518) (B) 메모리 브라우저(MOMO-529) (C) run 서빙 인스펙터(MOMO-529) (D) 도구 카탈로그/등록(MOMO-532) (E) ACP 세션 카드(MOMO-532·531). 티켓 수용기준 이관 시 이 문서의 §2가 원문.

- 조사일: 2026-07-21. 표기: 문서로 확인 못한 것 [미확인], 문서에 없는 추론 [추측].
- 전제: momo = Slack형 self-hosted 메신저(워크스페이스→채널→스레드), macOS SwiftUI 네이티브 우선, 에이전트=1급 멤버. 기존 자산: 세션=채널 스레드, 승인 카드(스레드 인라인), SwiftTerm 터미널 서랍(로컬/원격 attach), read-only 관전 attach(관전자 배지), 비용 스냅샷.

## §1 표면별 레퍼런스 표

### A. 산출물 카드 (diff 카드 · 커밋/PR 링크 카드 → 라인 앵커 코멘트)

| 레퍼런스 | 핵심 UI 패턴 (레이아웃·상호작용·상태) | momo 채택 권고 | 회피할 것 |
|---|---|---|---|
| **GitHub PR 리뷰** | Files changed: 파일별 접기 + unified/split 토글. 라인 코멘트=라인 클릭→인라인 폼, 멀티라인=Shift-클릭/드래그 범위. "suggested changes"=코멘트 안 편집 가능한 diff 블록, 버튼 한 번 커밋 적용(batch 가능) | 라인 앵커 문법의 사실상 표준 — v1 앵커 코멘트는 이 문법 그대로. suggested-change는 에이전트 재작업 지시로 전환 | 전체 Files changed 페이지를 스레드에 재현. 스레드 폭에서는 파일 요약+접기가 상한 |
| **Zed (Review Changes)** | 편집 파일·라인 수를 패널 상단 아코디언 요약, "Review Changes"→전용 멀티버퍼 탭. hunk/전체 단위 keep·reject. 파일 내 인라인 diff+동일 컨트롤 | **"아코디언 요약(카드)→전용 뷰(서랍)에서 hunk 리뷰" 2단 구조 = momo 카드+서랍 문법과 동형** | 에디터 멀티버퍼 모방. accept=파일 쓰기 모델(momo에선 리뷰≠쓰기) |
| **Cursor** | 멀티파일 편집을 하나의 리뷰 diff로 스테이징, 파일 단위 accept/reject, Cmd+Enter 전체 수락, read-only diff 뷰어 | 파일 단위+전체 일괄의 2단 승인 단위. read-only 렌더러 | 버전업마다 diff UI 회귀(포럼 불만) — diff 카드를 정본 계약으로 |
| **Vibe Kanban** | 완료 시 카드가 Review 컬럼 이동, diff 라인 코멘트가 **그대로 에이전트 피드백으로 회송**, attempt별 diff 비교 | "diff 코멘트=에이전트 재지시" 회송 루프 — momo에선 앵커 코멘트가 곧 스레드 메시지라 자연 획득, 명시 기능으로 | 보드 중심 UI(momo는 스레드가 정본) |
| **Jules (Google)** | activity feed에 **mini diff 인라인**, 우측 패널 전체 확장. 복수 파일 stacked(세로) 레이아웃 | 피드 안 mini diff+확장 뷰 = 카드 미리보기 몇 줄+서랍 확장. 좁은 폭=stacked가 정답 | split view 기본(좁은 스레드에서 불가독) |
| **GitHub Copilot coding agent** | 산출물=draft PR. **커밋 메시지마다 세션 로그 링크**(커밋→세션 역추적). author=Copilot, 지시자=co-author | 커밋/PR 카드에 "생성 run 스레드" 쌍방향 역링크. author/지시자 구분 | — |
| **Conductor (상용 macOS)** | 3패널: 워크스페이스 목록/채팅/우측 라이브 git diff+터미널(⌘⇧D) | macOS 네이티브 "채팅과 diff 병치" 검증 — momo는 카드+서랍으로 이식 | 상시 diff 패널(다채널 메신저 UI 침식) |
| **Graphite** | 스택 PR: 스택 위치 시각화·PR 간 내비게이션·리비전 드롭다운·키보드 리뷰 큐 | run이 복수 diff를 낳을 때 카드 간 이전/다음, diff 리비전(v1/v2) 개념 | diff와 코멘트를 다른 패널로 찢지 말 것 |
| GitLab MR | [미확인 — 1차 문서 미조사] | — | — |

### B. 워크스페이스 메모리 브라우저

| 레퍼런스 | 핵심 UI 패턴 | momo 채택 권고 | 회피할 것 |
|---|---|---|---|
| **OpenMemory (mem0)** | 메모리 목록+**상태 3단(active/pause/archive)**, 앱별 접근 통제(앱 단위 쓰기 정지·개별 pause/archive·카테고리 필터). **항목 상세에 접근 로그(누가 언제 read/write)+관련 메모리**. ACL=앱↔메모리 allow/deny 테이블 | **B의 최근접 원형** — "삭제 아닌 상태 전이" 모델·항목별 접근 로그·에이전트 단위 차단 스위치 채택 | 별도 웹 대시보드 격리(momo는 메신저 안 1급 표면 — 메시지 역링크가 살아야) |
| **Letta ADE** | core memory=라벨·limit 있는 **블록**(persona/human)이 상주, ADE에서 직접 읽고 편집, archival 검색 브라우저 | "블록(구조화·라벨)+항목(발견 사실)" 2계층. momo 스코프 4단=블록 라벨 체계로 대응 | 개발자 IDE 톤(일반 팀원에겐 텍스트 필드 수준 편집) |
| **ChatGPT 메모리 설정** | Manage memories: **행 단위 목록(+날짜)**·행별 삭제·전체 삭제. saved(명시) vs chat history(암묵) **2계층 별도 토글**. "Memory updated" 인라인 배지 | 1st-party 최소선: 행 목록+개별/전체 삭제. 명시 vs 자동 구분 표기, 기록 시 스레드 인라인 배지 | 출처 비표시(ChatGPT의 약점 — momo는 역링크로 차별화) |
| **Claude 메모리** | "View and edit your memory" — **편집 가능한 요약**, **프로젝트별 분리**, incognito 채팅 | 프로젝트 분리=채널/대화 스코프 동형. "이 스레드는 메모리 미기록"(incognito) 대화 정책 | 요약 단일 blob 편집만(항목 조작 불가면 무효화·역링크 불가) |
| **Open WebUI** | Personalization>Memory 수동 추가/편집/삭제, 모델별 Memory capability 토글(관리자) | "에이전트가 쓸 수 있는가"를 에이전트 단위 스위치로 | — |
| **LibreChat** | 메모리=key/value, 매 요청 시 **전담 memory agent**가 읽고 씀 | 주입 시점 명시 모델 — C와 연결("이 run에 주입된 키 목록") | — |
| **AnythingLLM** | 문서를 **embed(RAG)** 또는 **pin(상주)** 2단 부착, 워크스페이스 접근자 전원 공개 | **"pin=항상 주입 / embed=검색 시 주입"** = momo 메모리 주입 정책(상주 vs 검색) 그대로 | 문서 중심 어휘(momo는 대화발 사실이 1급) |
| **Lobe Chat** | 에이전트별 지식베이스+워크스페이스 공유 자원 | 에이전트별 vs 공유 스코프 구분 선례 | — |
| **Hindsight** | 대시보드 동봉 주장, UI 상세 [미확인] | — | — |

### C. run별 서빙 인스펙터

| 레퍼런스 | 핵심 UI 패턴 | momo 채택 권고 | 회피할 것 |
|---|---|---|---|
| **Letta ADE — Context Window Viewer** | **컨텍스트 윈도의 실제 구성 전체(메모리·상태·프롬프트·도구)를 그 시점 그대로 열람** — "보이지 않는 컨텍스트"의 1급 디버그 표면화(유일 사례) | **C의 개념 원형** — run 시점 "히스토리 범위+메모리 항목+tool grant" 스냅샷 뷰로 번역 | raw 토큰 덤프(일반 팀원에겐 구조화 섹션으로) |
| **Copilot 세션 로그** | 세션 리스트→로그+**오버뷰(진행·토큰·시간)**. 로그에 reasoning·도구 노출. **커밋→세션 역링크** 감사 동선. Stop은 로그 뷰어 안 | "산출물→run→서빙 내역" 3단 역추적. 토큰/시간 오버뷰=비용 스냅샷 접합 | — |
| **OpenMemory 접근 로그** | 항목별 "어떤 앱이 언제 읽었나" | 역방향 인덱스: 항목 상세에서 "주입된 run 목록" — B와 C 상호 링크 | — |
| **Devin planner/work log** | 단계별 아코디언+회고, "Follow Devin"이 행동 하이라이트+돋보기로 도구 화면 점프 | 아코디언+원본 점프(로그→터미널 서랍 지점) | 패널 5종 동시 노출(momo는 스레드+서랍 2면) |

### D. 에이전트 도구 카탈로그/등록

| 레퍼런스 | 핵심 UI 패턴 | momo 채택 권고 | 회피할 것 |
|---|---|---|---|
| **Zed — Agent Profiles+Tool Permissions** | 프로파일=도구 묶음 선택. 권한=도구 호출 패턴별 **allow/deny/confirm 3값 규칙** | **work_tool 프로파일=도구 묶음+per-tool 3값 정책 합성.** 관리자 UI=규칙 목록 편집기 | 설정 파일 편집만 제공 |
| **Roo Code — auto-approve** | **8개 행위 카테고리** 각 토글+**위험도 라벨(Low/Med/High)**+마스터 토글+All/None 칩 | 카테고리 정책+위험도 라벨. momo에선 개인 설정이 아닌 **프로파일(관리자 정본)** 귀속 | 마스터 토글로 전부 auto(YOLO) 기울기 |
| **Cline** | 승인 UI 팝업→**채팅 인라인 확장 메뉴**, auto-approve 기본 on 전환 | 승인 설정이 대화 흐름 안에 있는 배치 감각 | auto 기본 on(momo 신뢰 모델과 충돌 — 기본 confirm) |
| **LibreChat — Agent Marketplace** | 카테고리별 사전 구성 에이전트 마켓·공유·버전 | "카탈로그에서 골라 멤버로 초대" = ACP 레지스트리 선택과 동형 | — |
| **AnythingLLM — agent skills** | 커스텀 스킬 등록, **Hub 다운로드는 기본 차단(env 게이트)** | 외부 카탈로그 설치=관리자 게이트 뒤 기본값 | — |
| **Linear Agents** | **assignment(인간·책임)과 delegation(에이전트·실행)을 어휘부터 분리.** 에이전트 팀 접근=관리자 설정, Activity에 위임 이력 | 위임 어휘 분리+프로필에 에이전트 명시(disclosure)+접근 채널 관리자 부여 | 에이전트를 인간과 동일 assignee로 뭉개기 |
| **Mattermost Agents** | 시스템 콘솔에서 복수 에이전트 각각 구성, 사용자는 RHS에서 선택 | 구성=관리자 표면/선택=사용자 표면 분리 | — |
| **Zulip 봇 생성** | 봇 타입(Incoming webhook vs Generic) 능력 계층 | 등록 시 "웹훅 수준 vs 대화형 멤버" 계층 선택지 | — |

### E. ACP 세션 카드

| 레퍼런스 | 핵심 UI 패턴 | momo 채택 권고 | 회피할 것 |
|---|---|---|---|
| **ACP 스펙** | tool_call=**title+kind(read/edit/delete/move/search/execute/think/fetch/other)+status 4값(pending/in_progress/completed/failed)**. 콘텐츠 3종=일반·**diff(oldText/newText)**·**terminal(라이브, release 후 표시 유지)**. 승인=**allow_once/allow_always/reject_once/reject_always 4옵션**(UI 처리 클라 재량) | **E의 계약 그 자체**: kind→SF Symbol, status→배지, diff→A 카드 재사용, terminal→서랍 attach+카드 스냅샷 | 4옵션 임의 축소(2버튼)·allow_always를 눈에 띄게 배치 |
| **Zed agent panel** | 도구 사용 인디케이터, 편집마다 Restore Checkpoint, 메시지 수정 재제출, 완료 시 OS 알림/사운드, follow(crosshair), 토큰 상시 표시, Thread History | ACP 1호 클라의 검증 세부: 카드 체크포인트/개입 액션·macOS 네이티브 알림·토큰/비용 상시(CostBreathingRing 접합) | 패널 단일 스레드 한계 모방(momo는 다중 세션 병렬이 강점) |
| **OpenHands** | 대화 패널+탭(Changes/VS Code/Terminal/App/Browser) **작업면 종류별 분리**. confirmation mode(--llm-approve 위험도 판별) | "대화 하나, 작업면은 탭"→서랍 탭(터미널/diff/인스펙터). LLM 위험도 사전분류를 승인 카드 힌트로 [추측: 적용 형태] | 탭 5개 상시 노출 |
| **Cline/Roo** | 도구 호출 단위 approve/reject 채팅 인라인 | momo 승인 카드 동형 — 처리 후 이력 잔존이 메신저 장점 | 승인 요청 스크롤 유실(momo: ApprovalInbox 병행) |
| **Codex CLI** | 승인 3모드+/approvals 전환+전환 확인 표시 | run 단위 승인 모드 배지+전환도 메시지로 기록 | full access 기본 후보 노출 |
| **Happy (OSS 모바일)** | 로컬 Claude Code를 remote 모드 재시작해 폰 제어. **승인/에러/완료 푸시**(E2E 암호화)·다중 세션 목록 | **iOS v1 원형: 모바일=관전+승인+재개 최소셋.** 승인→푸시→해당 스레드 카드 | 모바일에 전체 IDE 재현 |
| **Jules** | 실행 전 **plan 승인 게이트**(단계 breakdown 펼침·코멘트·조정 후 승인), activity feed 라이브 로그+mini diff | **plan=승인 카드의 1형태**: 계획 카드(체크리스트)→승인→진행 체크 | — |
| **Devin** | Slack @Devin→세션 시작, 티켓에 링크, 상태 DM 푸시 | 메신저 문법은 momo가 네이티브로 이김 — 링크가 아니라 스레드가 세션 | 세션을 외부 링크로(메신저가 알림함으로 전락) |
| **Slack AI surface** | split view·**setStatus "is thinking..." 상태 문자열**·setSuggestedPrompts(≤4)·앱 스레드 | 상태 문자열: run 카드 상태 라인을 에이전트가 갱신하는 계약 | AI 전용 split 분리(봇 래핑 회귀 — momo 원칙 위배) |
| **Slack Block Kit 승인** | Approve/Deny 버튼, **처리 후 메시지 업데이트로 버튼 제거+결과·처리자 표기** | 승인 카드 상태 전이 표준: pending(버튼)→resolved(결과+처리자+시각 고정) — 계약 명문화 | 처리 후에도 버튼 살아있는 카드 |
| **Mattermost Agents** | 에이전트 대화 RHS 패널, 요약 DM 회신 | (반면교사) | 에이전트를 사이드 패널·DM으로 밀어내기 |

## §2 표면별 momo 구현 제안

공통 원칙: **카드=요약(스레드 인라인·고정 높이), 서랍=상세(MomoWorkConsoleDrawer 확장)**. 모든 카드는 `message.seq` 순서의 스레드 메시지로 SoT에 남는다. AI-slop 금지 — MomoDS 토큰과 SF Symbol.

### A. 산출물 카드 (MOMO-518)
- **v0 (macOS+웹)**: `DiffCardView` — 헤더(파일 수·+N/−M·브랜치), 파일별 접기(기본 접힘·첫 hunk 3~5라인 미리보기), **unified 고정**(스레드 폭 split 금지, stacked). "전체 보기"→서랍 Diff 탭. 커밋/PR 카드=`MomoMessageAttachmentCard` 변형(제목·브랜치·상태·**생성 run 스레드 역링크**). 웹은 `MessageContent.tsx`/`Timeline.tsx`에 DiffCard 추가.
- **v1**: 라인 앵커 코멘트 — 서랍 Diff 탭 라인(범위) 클릭→인라인 폼(GitHub 문법), 코멘트=스레드 메시지+카드 핀 배지 집계, "에이전트에게 보내기" 회송(Vibe Kanban). iOS=읽기 전용 카드+접기.
- **재사용**: MessageBubble/MessageThreadPanel/MessageTimelineLayout·MomoMessageAttachmentCard·MomoWorkConsoleDrawer·Core AgentEvent/AgentWorkRun. **신규 최소**: DiffCardView·DiffHunkRenderer(Core 인접)·CommitPRLinkCard·서랍 DiffTab, (v1) LineAnchorCommentModel+핀 오버레이.

### B. 메모리 브라우저 (MOMO-529 전반)
- **v0 (macOS)**: `MemoryBrowserView` 시트/윈도 — 좌 스코프 필터(4단), 중앙 행 리스트(요약·스코프 배지·생성일·상태). 상세: 전문 편집·**상태 전이(활성/일시정지/보관 — 삭제 대신 무효화)**·**출처 메시지 역링크(→스레드 점프)**·"주입된 run 목록"(C 상호 링크). 관리자 스위치: 에이전트별 쓰기 on/off·스코프별 자동 추출 on/off·대화 incognito. 진입점: MomoChannelMemberInspectorView 에이전트 프로필 "이 에이전트가 아는 것"+QuickSwitcher 검색.
- **v1**: 웹 설정 페이지 이식, iOS 열람 전용.
- **재사용**: MomoChannelMemberInspectorView·MomoQuickSwitcherSearch·MomoAccountSettingsViews·MomoSidebarPolicy. **신규 최소**: MemoryBrowserView·MemoryEntryRow·MemoryEntryDetail·MemoryPolicyPane·Core MemoryEntry/MemoryScope.

### C. run 서빙 인스펙터 (MOMO-529 후반)
- **v0 (macOS)**: run 카드(AgentWorkRunViews) "서빙 내역"→서랍 `InspectorTab`. 섹션: ①히스토리(채널/스레드 seq 범위, 클릭→메시지 점프) ②메모리(항목→B 상세) ③tool grant(프로파일명+도구·정책) ④요약 헤더(토큰·비용·시간 — CostBreathingRing 데이터). run 종료 후에도 **스냅샷 불변 read-only**(=528의 저장된 packet 조회).
- **v1**: 관리자 워크스페이스 감사 목록(run 횡단), 웹 이식.
- **재사용**: AgentWorkRunViews/AgentWorkPresentation·MomoWorkConsoleDrawer·CostBreathingRing·Core AgentWorkRun/WorkSession. **신규 최소**: RunInspectorTab·ManifestSectionView (서버측 packet 저장은 MOMO-528).

### D. 도구 카탈로그/등록 (MOMO-532 전반)
- **v0 (macOS)**: ①`WorkToolProfileEditor` — 프로파일=도구 목록+도구별 **allow/deny/confirm 3값**+위험도 라벨, CLI 등록 폼(명령·인자 템플릿·실행 호스트) ②에이전트 카탈로그 — PluginMarketplaceView 골격 재사용, ACP 레지스트리 목록(이름·제공자·능력 배지)→"워크스페이스 멤버로 초대" ③pairing 확장 — 위임 어휘·에이전트 disclosure·접근 채널 관리자 부여(Linear). 외부 카탈로그 설치=관리자 게이트 기본 잠금.
- **v1**: 웹 관리자 콘솔. iOS 제외.
- **재사용**: PluginMarketplaceView·MomoAgentPairing·MomoAgentCredentialViews·MomoAgentCapabilityBadges·MemberDirectoryView·Core WorkHost/WorkControl. **신규 최소**: WorkToolProfileEditor·ToolPolicyRow·AgentCatalogView·Core WorkToolProfile.

### E. ACP 세션 카드 (MOMO-532 후반·531 소비)
- **v0 (macOS)**: `AcpSessionCard` — 헤더(아바타·세션 상태·승인 모드 배지·관전자 배지 재사용), **plan 섹션=체크리스트**(단계 체크 진행), tool_call 라인(kind→SF Symbol·title·status 4값 배지; execute=터미널 스냅샷 몇 줄+클릭 시 SwiftTerm 서랍 attach·종료 후 보존), diff 콘텐츠=A의 DiffCardView 재사용. **승인=기존 카드에 ACP 4옵션 매핑**: 주 버튼 "이번만 허용"/"거부"+보조(작게) "항상 허용/항상 거부"(ApprovalDecisionControls 확장·처리 후 고정=기존 준수). 상태 문자열 라인(Slack setStatus 패턴) 카드 하단. 완료/대기 시 macOS 네이티브 알림(MomoDockUnreadBadge 연동).
- **v1**: 웹(ApprovalCard.tsx 확장+이식), iOS=Happy 패턴(세션 목록+승인/에러/완료 푸시+승인 카드+read-only 관전).
- **재사용**: AgentWorkRunViews/AgentProtocolCardMetadata·ApprovalDecisionControls/ApprovalInboxView·MomoWorkConsoleDrawer+터미널 세션 2종+MomoTerminalTheme·관전 attach(MOMO-516)·CostBreathingRing. **신규 최소**: AcpSessionCard·PlanChecklistView·ToolCallRow·AcpPermissionOptionsView·ACP session/update→Core 이벤트 어댑터(update도 REST→PG→outbox 경로 — 전송전용 불변식).

## §3 공통 패턴 교훈 (수렴 11)

1. **"카드=요약, 전용 면=상세" 전방위 수렴**(Zed·Jules·Conductor·OpenHands·Copilot) — momo 스레드 카드+서랍 문법과 정확히 일치. 카드에 욱여넣은 제품이 없다.
2. **승인 4형(이번만/항상 × 허용/거부) 표준화**(ACP 스펙 명문화, Zed 3값 규칙, Roo 카테고리+위험도, Codex 모드 사다리) — 단발 버튼만은 구세대.
3. **처리된 승인 카드=불변 이력 고정**(Slack 관례: 버튼 제거+처리자·결과) — 메신저인 momo는 공짜로 얻는다. 카드가 곧 감사 로그.
4. **plan은 1급 UI 객체**(Jules 승인 게이트·Zed plan·Devin planner) — "계획 카드→승인→체크리스트 진행"이 신뢰 UI의 뼈대.
5. **status 4값 배지+사람 언어 상태 문자열 병행**(ACP enum+Slack setStatus).
6. **관전과 개입은 어휘부터 분리**(Linear assignment vs delegation, Copilot 관전+Stop만) — momo 관전자/개입자 어휘로 드러낼 것.
7. **산출물→run 역링크가 감사 동선의 핵심**(Copilot 커밋→세션) — momo는 diff·PR·메모리·인스펙터 전부가 스레드 메시지로 역링크되는 그래프 가능. 1st-party에도 없는 차별점.
8. **터미널=라이브 스트림+종료 후 보존 계약**(ACP 명시) — 카드 스냅샷 몇 줄+서랍 전체 2단.
9. **메모리 UI 수렴 최소선**: 행 목록+개별/전체 삭제+스코프 분리+자동/수동 구분. 차별화 여지=상태 전이·접근 로그·컨텍스트 조립 가시화 — **momo B+C 결합이 현존 오픈소스 최전선의 합집합**.
10. **완료·대기는 OS 네이티브 알림으로 탈출**(Zed 알림·Happy 푸시·Devin DM) — "기다리는 에이전트"를 놓치게 하는 UI가 최악. momo=승인 인박스+Dock 배지+푸시 3중.
11. **반면교사: 에이전트를 사이드 패널/DM/외부 링크로 밀어내면 메신저는 알림함이 된다**(Mattermost RHS·Slack split·Devin 링크) — momo "세션=스레드" 원칙이 구조적 우위.

## §출처 (전부 2026-07-21 확인)

- Zed: zed.dev/docs/ai/agent-panel(원문 github.com/zed-industries/zed docs) · tool-permissions · agent-profiles
- ACP: agentclientprotocol.com/protocol/tool-calls
- OpenHands: github.com/OpenHands/OpenHands · docs.openhands.dev(key-features·cli/terminal — GUI 개요 직접 fetch 404, 탭 구성은 key-features+검색 요약 기반)
- Cline: docs.cline.bot/features/auto-approve · cline.bot/blog/cline-v3-35 / Roo: docs.roocode.com/features/auto-approving-actions
- Vibe Kanban: github.com/BloopAI/vibe-kanban · vibekanban.com / Happy: github.com/slopus/happy
- Conductor: conductor.build(docs·parallel-agents 가이드) / Terragon: github.com/terragon-labs/terragon-oss(2026-01-16 서비스 종료·OSS 스냅샷)
- Copilot coding agent: docs.github.com(manage-and-track-agents) · github.blog/changelog/2026-03-20(커밋→세션 추적)
- Devin: docs.devin.ai/integrations/slack · cognition.com/blog/dec-24-product-update / Jules: jules.google/docs(running-tasks·code·changelog)
- Codex 승인: developers.openai.com/codex/agent-approvals-security · openai.com(codex upgrades) / Claude Code CLI 승인 문법: [미확인]
- Mattermost Agents: docs.mattermost.com/agents(user·admin guide) / Slack: docs.slack.dev(split-view·setStatus) · api.slack.com(ai-best-practices·approval-workflows 튜토리얼·interactive-messages)
- Zulip: zulip.com/help(topics)·/api/writing-bots·readthedocs(ai-integrations) / Rocket.Chat: docs.rocket.chat(rocketchat-ai-app) / Discord: docs.discord.com(components/reference)
- OpenMemory: mem0.ai/blog(openmemory-mcp)·docs.mem0.ai / Letta ADE: docs.letta.com(ade/overview·**context-window-viewer**·memory-blocks)
- Open WebUI: docs.openwebui.com(memory) / AnythingLLM: docs.anythingllm.com(documents·custom skills) / LibreChat: librechat.ai/docs(memory·agents) / Lobe: github.com/lobehub·lobehub.com/docs / ChatGPT: help.openai.com(8590148)·openai.com(memory-and-new-controls) / Claude: claude.com/blog/memory·support.claude.com(12123587) / Hindsight: github.com/hindsight-ai/hindsight-ai([미확인] UI 상세)
- GitHub PR: docs.github.com(commenting-on-a-pull-request)·github.blog(multi-line suggestions) / GitLab: [미확인] / Graphite: graphite.com(docs·stacked-diffs) / Cursor: cursor.com/docs/agent/review·changelog/2-4 / Linear: linear.app/docs/agents-in-linear·developers/agent-interaction·changelog 2025-07-30
- momo 내부 재사용 근거: clients/macOS/Sources/MomoMac(AgentWorkRunViews·ApprovalDecisionControls·ApprovalInboxView·MomoWorkConsoleDrawer·MomoLocalTerminalSession·MomoRemoteTerminalSession·MomoAgentPairing·MomoAgentCredentialViews·PluginMarketplaceView·MomoChannelMemberInspectorView·CostBreathingRing 등)·clients/Core(AgentWorkRun·Approval·WorkSession·WorkHost·AgentEvent)·clients/web/src/ui(ApprovalCard·ApprovalsPanel·Timeline)
