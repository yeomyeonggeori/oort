# UXUI 순차 배치 — 잔여 전량 (2026-07-21, 성재 지시: "동생 몫으로 전부, 순차 처리")

> **소비자: 동생(UXUI 트랙 세션).** 이 문서가 이 배치의 정본이다 — 아래 순서대로 하나씩 처리하고, 항목마다 자기 트랙(track/uxui) 랜딩까지는 자율, main 머지는 성재 승인.
> 기준 커밋: **main = track/uxui = 4e41132** (관전 attach·웹 클라·티어 폴백·푸시 v2·props 정합 전부 포함). 시작 전 `git pull`만 하면 됨 — 충돌 없음.
> 엔진 의존: **9번(525)만 엔진 564 랜딩 대기**, 나머지 8개는 지금 전부 착수 가능(서버 계약 main에 있음).

## 진행 규칙 (공통)

- 한 번에 한 항목. 항목 완료(자기 트랙 랜딩) 후 다음으로. 병렬 금지 — ConversationViews 등 핫파일 충돌 방지.
- goal 이슈는 착수 시 동생이 발급(제목에 MOMO 번호), PR base = track/uxui. 1이슈-1PR 강제는 아님(동생 워크플로 7원칙 그대로).
- **게이트**: macOS면 전체 tests+real-window(실디스플레이)+design-review(Blocker 0), iOS면 `scripts/verify_ios_build.sh`+MomoiOSKit tests. 시뮬레이터 스냅샷·실기기는 형(Fable) 오케스트레이터 게이트로 남겨도 됨 — STATUS에 `runtime-unverified` 명시하면 형이 돌려줌.
- **verifier/계약 함정 전례**(형이 이번 주 잡은 것 — 같은 함정 주의): Swift `UUID.uuidString`은 대문자(서버 비교·테스트 시 lower 정규화) / 토큰 만료 시 화면 전체 대체 금지(기존 데이터 유지+인라인 배너 — MOMO-514) / capability·토큰은 URL 쿼리·로그·UserDefaults 금지.
- 막히면: 엔진 계약 갭은 ENGINE_HANDOFF §X에 역요청 등재 + 형(Fable)에게 전달. 추측 구현 금지(fail-closed).

## 순서와 항목

### 1. 511-U 실데이터 액션 개방 (소형 — 워밍업)
- **뭐**: X-8이 main 랜딩됨 — `GET work-sessions` 응답의 `remoteAttachAvailable`(bool)을 소비해, 지금 fail-closed로 숨겨둔 "터미널 열기" 액션을 실데이터 세션에 개방. `runtime-unverified` 딱지 해제.
- **참조**: `MomoWorkConsoleDrawer.swift`·`MomoRemoteTerminalSession.swift`(A-12 구현), OpenAPI `WorkSession`. 수용: 미결속 세션엔 여전히 미노출, 결속 세션에 노출 + 기존 Work Console tests 회귀 0.

### 2. MOMO-505·506 — iOS Work 탭 + 세션 상세 (차별화 핵심)
- **뭐**: 모바일 플랜 Phase D. 505=Work 탭(세션 카드 리스트 — 상태 칩·tool 아이콘·호스트 표시명·시작/경과, `GET work-sessions`+`work.session.*` realtime, work_pool 슬롯 행). 506=세션 상세(카드 스레드 관전+개입 입력(work_input)+승인 카드 인라인+auto-approve 토글(X-6 GET)).
- **참조**: docs/planning/handoffs/2026-07-20-ios-v1-mobile-plan.md §MOMO-505/506(수용기준 포함). Claude 앱 문법. **가산 수용기준**: ①AgentPartial(중간출력 스트림) 소비를 506 카드에 포함 ②iOS 설정에 개발자 모드 토글 — off면 Work 탭을 요약 카드로 축소(진행 중 N/완료 N만).
- 서버 의존 0(전부 main). 모바일 E2E 1왕복(폰 승인→맥 실행→개입→발췌)은 형과 수동 QA.

### 3. MOMO-517 — macOS 관전 터미널 뷰 (ADR-0126 D1 UXUI)
- **뭐**: 팀원이 남의 세션 터미널을 read-only로 보는 뷰. `POST .../terminal-attach {mode:"observer"}` 소비(비소유자용) → SwiftTerm read-only 렌더(입력 차단 UI 명시), `observerGrantCount` 배지("관전 N"), 소유자용 observation 토글(open/owner_only — PATCH).
- **참조**: ADR-0126 D1, OpenAPI `issueTerminalAttachCapability`(mode 필드), `verify_observer_attach.sh`가 계약 예시. 기존 A-12 attach 코드 재사용(mode만 분기). 수용: observer로 stdin 전송 시도 자체가 UI에서 불가, owner_only 세션은 액션 미노출.

### 4. MOMO-520 — 호스트 상실 전환 제안 카드 (ADR-0125 D11 UXUI, A-14)
- **뭐**: `work.session.orphaned` realtime + 스레드의 `approval_request(props.kind=resume_offer)` 카드 렌더 → 사용자가 대상 호스트 선택 → `POST .../work-sessions/:id/resume` 호출 → `resumedFromSessionId` 계보를 같은 스레드에 이어 표시. 설정에 티어 정책(t1_only/ask/auto — `WorkTierPolicyRoutes` GET/PUT).
- **참조**: ADR-0125 D11, `verify_tier_fallback.sh`가 계약 예시. 수용: ask 카드 왕복 + t1_only는 카드 미표시 + 계보 스레드 연속성.

### 5. MOMO-504 — iOS 알림 UX v2 (A-13)
- **뭐**: APNs category 4종(`momo.message|mention|approval|work`) 등록 → 메시지=빠른 답장(text action→REST), 승인=승인/거부 액션(잠금화면→기존 승인 REST), work=세션 딥링크. `thread-id` 그룹핑, 서버 badge 소비, C-3 딥링크 종결(알림 탭→정확한 채널/스레드), 알림 설정 화면(카테고리 on/off+음소거 연동).
- **참조**: 모바일 플랜 §MOMO-504, `PushDispatch.swift`·`docs/PUSH_RELAY_RUNBOOK.md`·`verify_push_notifier.sh`. NSE id-only 경계 유지. 실기기 3종 실증은 형/성재 수동.

### 6. iOS 500 → 501 → 502 (메시징 패리티 잔여 — 순서 고정)
- **500 스레드 1급**: rollup 배지(`Message.thread`)·스레드 화면(replies cursor)·thread.updated 실시간·스레드 컴포저(rootId)·홈 Threads 목록(v0 로컬 집계). 수용: 맥↔폰 왕복.
- **501 첨부**: 컴포저 +(사진/파일/카메라)→세션→직송 PUT→complete→attachmentIds(macOS A-6 계약 동일·capability URL 무유출). 수신 인라인/카드/QuickLook. 수용: 폰→맥·맥→폰 실왕복.
- **502 검색+활동 탭**: 서버 FTS(debounce·cursor·snippet·점프), 활동 탭(멘션·반응 피드 — v0 클라 집계).
- **참조**: 모바일 플랜 §MOMO-500/501/502(수용기준 포함).

### 7. MOMO-514 — iOS 토큰 자동 리프레시 (#554, QA 발견 결함)
- **뭐**: 401 수신 시 refreshToken으로 자동 갱신 후 1회 재시도(실패 시에만 재로그인 유도). 히스토리 갱신 실패 시 기존 메시지 유지 + 상단 인라인 재시도 배너 — **전체 화면 대체 금지**.
- **참조**: 이슈 #554(재현·캡처 포함). 웹(clients/web)은 이미 이 패턴 구현됨 — `clients/web/src/api/client.ts` 회전 로직이 참고 레퍼런스.

### 8. MOMO-518 — 산출물 카드 v0: diff·커밋/PR 카드 (ADR-0126 D2)
- **뭐**: 세션 스레드 발췌 중 unified diff를 감지해 diff 카드 렌더(파일별 접기·± 요약·모노스페이스), 커밋/PR 링크를 메타 카드로 승격. props 계약 `artifact_kind: diff|commit|pr` — macOS·iOS 공용(가능하면 Core에 파서, 수정은 가산만).
- **참조**: ADR-0126 D2. momo-design-taste §4(구조적·차분·밀도) 준수.

### 9. MOMO-525 — 멤버 관리 표면 (ADR-0128 UXUI) ⚠️ 엔진 564 main 랜딩 후
- **뭐**: roster/멤버 목록에 역할 드롭다운(계층 규칙 — 자기보다 높은 역할 비활성), 정지/추방(확인 다이얼로그·사유 optional)/차단 토글, guest 표시, 초대 role 선택 기존 UI와 정렬.
- **참조**: ADR-0128 D1~D3, `verify_membership_lifecycle.sh`(랜딩 후). **착수 전 형에게 564 랜딩 여부 확인.**

## 완료 보고
각 항목 랜딩 시 STATUS 갱신(기존 컨벤션) + 형(Fable)에게 항목 번호만 알리면 형이 오케스트레이터 게이트(시뮬레이터·real-window·design-review·docker) 돌리고 main 머지 배치를 성재에게 올림.
